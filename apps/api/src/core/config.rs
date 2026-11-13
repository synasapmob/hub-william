use std::{env, fmt};

use axum::http::{HeaderName, HeaderValue};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

#[derive(Clone)]
pub struct AppConfig {
    pub client_ip_header: HeaderName,
    pub cookie_secure: bool,
    /// Added to the names of the session cookies. A browser keeps cookies per host
    /// and not per port, so two APIs on `localhost` (plain HTTP, local development)
    /// would share one session cookie and sign each other out; each puts its port in
    /// the names instead. Empty behind HTTPS, where there is one API.
    pub cookie_name_suffix: String,
    pub credential_encryption_key: [u8; 32],
    pub frontend_origin: HeaderValue,
    /// Encrypts the accounts a Telegram package hands to a buyer. Separate from
    /// the provider credential key so one leak does not open both. Unset, the
    /// service runs and simply cannot load accounts.
    pub stock_encryption_key: Option<[u8; 32]>,
    /// The keys callers present, from `SHOP_KEYS`. What each name may do is decided
    /// in `api::access`, not here.
    pub shop_keys: Vec<ShopKey>,
    /// The bucket the dashboard's icons are kept in, from the `R2_*` variables.
    /// Unset or incomplete, the shop runs and simply cannot read or change icons.
    pub icon_storage: Option<IconStorage>,
    /// Where `apps/telegram` listens, so the dashboard can have the bot send a
    /// message. Unset, the dashboard can read and change the shop but not announce.
    pub telegram_adapter_url: Option<reqwest::Url>,
    /// Usernames that are always owners of the dashboard, so the first owner
    /// needs no row in `dashboard_staff`.
    /// Lets the service wallet be topped up without a payment. For staging only:
    /// production leaves it off until payments exist.
    pub service_test_top_up: bool,
    /// The Stripe secret key (`sk_test_…` in test mode) the service wallet is paid
    /// in with. Unset, a wallet cannot be paid in by card.
    pub stripe_secret_key: Option<String>,
    /// The signing secret (`whsec_…`) of the webhook endpoint Stripe reports a
    /// payment to. Set together with the secret key.
    pub stripe_webhook_secret: Option<String>,
    /// Where Stripe's API is. Only tests change it.
    pub stripe_api_url: String,
    /// Read the client IP from `client_ip_header` instead of the socket peer.
    /// Only safe behind a proxy that overwrites that header.
    pub trust_proxy_headers: bool,
    pub codex_client_version: String,
    pub codex_issuer: String,
    pub claude_authorize_url: String,
    pub claude_client_version: String,
    pub claude_profile_url: String,
    pub claude_redirect_url: String,
    pub claude_token_url: String,
    pub gemini_authorize_url: String,
    pub gemini_client_id: String,
    pub gemini_client_secret: String,
    pub gemini_code_assist_url: String,
    pub gemini_redirect_url: String,
    pub gemini_token_url: String,
    pub gemini_userinfo_url: String,
    pub grok_issuer: String,
    pub grok_client_id: String,
    pub grok_client_version: String,
    pub deepseek_api_url: String,
    pub groq_api_url: String,
    pub chatgpt_codex_models_url: String,
    pub claude_models_url: String,
}

/// The name the Telegram bot's key is issued under.
pub const TELEGRAM_KEY_NAME: &str = "telegram";

/// Short enough to guess is short enough to be someone else's key.
const MINIMUM_SHOP_KEY_LENGTH: usize = 32;

/// A key issued to one caller. It has no `Debug` so it cannot reach a log.
#[derive(Clone)]
pub struct ShopKey {
    pub name: String,
    pub key: Vec<u8>,
}

/// Reads `name:key,name:key`. An entry that cannot be used is left out and
/// described in the second value, never with its key: one bad entry costs that
/// caller its access, not the whole API its start, because the gateway runs in the
/// same process.
fn parse_shop_keys(raw: &str) -> (Vec<ShopKey>, Vec<String>) {
    let mut keys: Vec<ShopKey> = Vec::new();
    let mut problems = Vec::new();

    for (index, entry) in raw.split(',').enumerate() {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let position = index + 1;
        let Some((name, key)) = entry.split_once(':') else {
            problems.push(format!("entry {position} is not name:key"));
            continue;
        };
        let (name, key) = (name.trim(), key.trim());

        if name.is_empty()
            || !name.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'_' | b'-')
            })
        {
            problems.push(format!(
                "entry {position} has a name that is not lowercase letters, digits, . _ or -"
            ));
        } else if key.len() < MINIMUM_SHOP_KEY_LENGTH
            || !key.bytes().all(|byte| byte.is_ascii_graphic())
        {
            problems.push(format!(
                "the key of {name} is not at least {MINIMUM_SHOP_KEY_LENGTH} visible characters"
            ));
        } else if keys.iter().any(|issued| issued.name == name) {
            problems.push(format!("{name} appears more than once"));
        } else if keys.iter().any(|issued| issued.key == key.as_bytes()) {
            problems.push(format!("the key of {name} is the key of another entry"));
        } else {
            keys.push(ShopKey {
                name: name.to_owned(),
                key: key.as_bytes().to_vec(),
            });
        }
    }

    (keys, problems)
}

/// A Cloudflare R2 bucket that holds the icons: the API writes to it through the
/// S3 API, and browsers read it at its public address. It has no `Debug` so the
/// secret cannot reach a log.
#[derive(Clone)]
pub struct IconStorage {
    pub account_id: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub bucket: String,
    /// Where the bucket is public, without a trailing slash. An icon is stored as
    /// its name in the bucket and shown at this address, so a move to another domain
    /// changes this one value and no row.
    pub public_url: String,
}

/// The variables `IconStorage` is read from, in the order they are checked.
const ICON_STORAGE_VARIABLES: [&str; 5] = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
    "R2_PUBLIC_URL",
];

/// Reads the `R2_*` variables through `lookup`. All five unset is a shop with no
/// icon storage and says nothing; some set and some not, or a value that cannot be
/// used, leaves the storage off and is described in the second value, never with a
/// secret. It is not an error that stops the API: the gateway runs in the same
/// process, and variables added one at a time to a platform that restarts on each
/// would otherwise take it down halfway.
fn parse_icon_storage(
    lookup: impl Fn(&str) -> Option<String>,
) -> (Option<IconStorage>, Vec<String>) {
    let values = ICON_STORAGE_VARIABLES.map(&lookup);

    if values.iter().all(Option::is_none) {
        return (None, Vec::new());
    }

    let [
        Some(account_id),
        Some(access_key_id),
        Some(secret_access_key),
        Some(bucket),
        Some(public_url),
    ] = &values
    else {
        let missing: Vec<&str> = ICON_STORAGE_VARIABLES
            .iter()
            .zip(&values)
            .filter(|(_, value)| value.is_none())
            .map(|(name, _)| *name)
            .collect();

        return (
            None,
            vec![format!("{} must be set as well", missing.join(", "))],
        );
    };

    // The account id is put in a host name, and the two keys in a signature, so
    // each must be one run of visible characters.
    let plain = |value: &str| value.bytes().all(|byte| byte.is_ascii_alphanumeric());
    let visible = |value: &str| value.bytes().all(|byte| byte.is_ascii_graphic());
    let mut problems = Vec::new();

    if !plain(account_id) {
        problems.push("R2_ACCOUNT_ID must be letters and digits only".to_owned());
    }
    if !visible(access_key_id) {
        problems.push("R2_ACCESS_KEY_ID must be visible characters only".to_owned());
    }
    if !visible(secret_access_key) {
        problems.push("R2_SECRET_ACCESS_KEY must be visible characters only".to_owned());
    }
    // How Cloudflare names a bucket: 3 to 63 lowercase letters, digits and hyphens,
    // not starting or ending with a hyphen.
    if !(3..=63).contains(&bucket.len())
        || !bucket
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        || bucket.starts_with('-')
        || bucket.ends_with('-')
    {
        problems.push("R2_BUCKET is not a bucket name".to_owned());
    }
    let public_url = public_url.trim_end_matches('/');
    match reqwest::Url::parse(public_url) {
        Ok(url)
            if url.scheme() == "https"
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none() => {}
        _ => problems.push("R2_PUBLIC_URL must be an https address with no query".to_owned()),
    }

    if !problems.is_empty() {
        return (None, problems);
    }

    (
        Some(IconStorage {
            account_id: account_id.clone(),
            access_key_id: access_key_id.clone(),
            secret_access_key: secret_access_key.clone(),
            bucket: bucket.clone(),
            public_url: public_url.to_owned(),
        }),
        Vec::new(),
    )
}

#[derive(Debug)]
pub struct ConfigError(String);

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

/// An environment variable that is set to something other than blanks.
fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

impl AppConfig {
    /// Every key a caller can present, with the name it was issued under.
    pub(crate) fn issued_keys(&self) -> impl Iterator<Item = (&str, &[u8])> {
        self.shop_keys
            .iter()
            .map(|shop| (shop.name.as_str(), shop.key.as_slice()))
    }

    /// The key the bot holds, which the API also presents when it calls the bot.
    pub(crate) fn telegram_key(&self) -> Option<&[u8]> {
        self.issued_keys()
            .find(|(name, _)| *name == TELEGRAM_KEY_NAME)
            .map(|(_, key)| key)
    }

    pub fn from_env() -> Result<Self, ConfigError> {
        let frontend_origin =
            env::var("FRONTEND_ORIGIN").unwrap_or_else(|_| "http://localhost:5173".to_owned());
        let frontend_origin = HeaderValue::from_str(&frontend_origin)
            .map_err(|_| ConfigError("FRONTEND_ORIGIN must be a valid HTTP origin".to_owned()))?;
        let cookie_secure = env::var("COOKIE_SECURE")
            .map(|value| value.eq_ignore_ascii_case("true") || value == "1")
            .unwrap_or(false);
        let cookie_name_suffix = if cookie_secure {
            String::new()
        } else {
            // The port `main` listens on, which defaults to 8080.
            let port = env::var("PORT")
                .ok()
                .and_then(|port| port.trim().parse::<u16>().ok())
                .unwrap_or(8080);

            format!("_{port}")
        };
        let trust_proxy_headers = env::var("TRUST_PROXY_HEADERS")
            .map(|value| value.eq_ignore_ascii_case("true") || value == "1")
            .unwrap_or(false);
        let client_ip_header = env::var("CLIENT_IP_HEADER")
            .unwrap_or_else(|_| "x-real-ip".to_owned())
            .parse::<HeaderName>()
            .map_err(|_| ConfigError("CLIENT_IP_HEADER must be a valid header name".to_owned()))?;
        let credential_encryption_key =
            env::var("PROVIDER_CREDENTIAL_ENCRYPTION_KEY").map_err(|_| {
                ConfigError(
                    "PROVIDER_CREDENTIAL_ENCRYPTION_KEY must be a base64url-encoded 32-byte key"
                        .to_owned(),
                )
            })?;
        let credential_encryption_key = URL_SAFE_NO_PAD
            .decode(credential_encryption_key)
            .map_err(|_| {
                ConfigError(
                    "PROVIDER_CREDENTIAL_ENCRYPTION_KEY must be a base64url-encoded 32-byte key"
                        .to_owned(),
                )
            })?
            .try_into()
            .map_err(|_| {
                ConfigError(
                    "PROVIDER_CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes".to_owned(),
                )
            })?;

        // A key that is set but wrong is refused at start, not ignored: running
        // without the encryption the operator thinks is on is the worse mistake.
        let stock_encryption_key = non_empty_env("STOCK_ENCRYPTION_KEY")
            .map(|value| {
                URL_SAFE_NO_PAD
                    .decode(value)
                    .ok()
                    .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
                    .ok_or_else(|| {
                        ConfigError(
                            "STOCK_ENCRYPTION_KEY must be a base64url-encoded 32-byte key"
                                .to_owned(),
                        )
                    })
            })
            .transpose()?;

        let (shop_keys, shop_key_problems) =
            parse_shop_keys(&non_empty_env("SHOP_KEYS").unwrap_or_default());
        for problem in shop_key_problems {
            eprintln!("SHOP_KEYS: {problem}; that entry is ignored");
        }
        // The bot's key used to be set here. It is no longer read, so a deploy that
        // still relies on it would have the bot answered with 403.
        if non_empty_env("TELEGRAM_SERVICE_TOKEN").is_some() {
            eprintln!(
                "TELEGRAM_SERVICE_TOKEN is no longer read; give the bot's key to SHOP_KEYS as telegram:<key> and remove the variable"
            );
        }

        let (icon_storage, icon_storage_problems) = parse_icon_storage(non_empty_env);
        for problem in &icon_storage_problems {
            eprintln!("{problem}; icon storage is off");
        }
        if let Some(storage) = &icon_storage {
            eprintln!("icon storage is on, in the bucket {}", storage.bucket);
        }

        let stripe_secret_key = non_empty_env("STRIPE_SECRET_KEY");
        let stripe_webhook_secret = non_empty_env("STRIPE_WEBHOOK_SECRET");
        if stripe_secret_key.is_some() != stripe_webhook_secret.is_some() {
            return Err(ConfigError(
                "STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must be set together".to_owned(),
            ));
        }

        Ok(Self {
            client_ip_header,
            cookie_secure,
            cookie_name_suffix,
            credential_encryption_key,
            stock_encryption_key,
            frontend_origin,
            shop_keys,
            icon_storage,
            telegram_adapter_url: env::var("TELEGRAM_ADAPTER_URL")
                .ok()
                .filter(|url| !url.trim().is_empty())
                .map(|url| {
                    reqwest::Url::parse(url.trim()).map_err(|_| {
                        ConfigError("TELEGRAM_ADAPTER_URL must be a valid URL".to_owned())
                    })
                })
                .transpose()?,
            trust_proxy_headers,
            service_test_top_up: env::var("SERVICE_TEST_TOP_UP")
                .map(|value| value.eq_ignore_ascii_case("true") || value == "1")
                .unwrap_or(false),
            stripe_secret_key,
            stripe_webhook_secret,
            stripe_api_url: env::var("STRIPE_API_URL")
                .unwrap_or_else(|_| "https://api.stripe.com".to_owned()),
            codex_client_version: env::var("CODEX_CLIENT_VERSION")
                .unwrap_or_else(|_| "0.156.0".to_owned()),
            codex_issuer: env::var("CODEX_AUTH_ISSUER")
                .unwrap_or_else(|_| "https://auth.openai.com".to_owned()),
            claude_authorize_url: env::var("CLAUDE_AUTHORIZE_URL")
                .unwrap_or_else(|_| "https://claude.com/cai/oauth/authorize".to_owned()),
            claude_client_version: env::var("CLAUDE_CLIENT_VERSION")
                .unwrap_or_else(|_| "2.1.223".to_owned()),
            claude_profile_url: env::var("CLAUDE_PROFILE_URL")
                .unwrap_or_else(|_| "https://api.anthropic.com/api/oauth/profile".to_owned()),
            claude_redirect_url: env::var("CLAUDE_REDIRECT_URL")
                .unwrap_or_else(|_| "https://platform.claude.com/oauth/code/callback".to_owned()),
            claude_token_url: env::var("CLAUDE_TOKEN_URL")
                .unwrap_or_else(|_| "https://platform.claude.com/v1/oauth/token".to_owned()),
            gemini_authorize_url: env::var("GEMINI_AUTHORIZE_URL")
                .unwrap_or_else(|_| "https://accounts.google.com/o/oauth2/auth".to_owned()),
            gemini_client_id: env::var("GEMINI_OAUTH_CLIENT_ID").unwrap_or_else(|_| {
                "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
                    .to_owned()
            }),
            gemini_client_secret: env::var("GEMINI_OAUTH_CLIENT_SECRET").map_err(|_| {
                ConfigError(
                    "GEMINI_OAUTH_CLIENT_SECRET must be set for Google subscription authorization"
                        .to_owned(),
                )
            })?,
            gemini_code_assist_url: env::var("GEMINI_CODE_ASSIST_URL")
                .unwrap_or_else(|_| "https://daily-cloudcode-pa.googleapis.com".to_owned()),
            gemini_redirect_url: env::var("GEMINI_REDIRECT_URL")
                .unwrap_or_else(|_| "https://antigravity.google/oauth-callback".to_owned()),
            gemini_token_url: env::var("GEMINI_TOKEN_URL")
                .unwrap_or_else(|_| "https://oauth2.googleapis.com/token".to_owned()),
            gemini_userinfo_url: env::var("GEMINI_USERINFO_URL")
                .unwrap_or_else(|_| "https://www.googleapis.com/oauth2/v2/userinfo".to_owned()),
            grok_issuer: env::var("GROK_AUTH_ISSUER")
                .unwrap_or_else(|_| "https://auth.x.ai".to_owned()),
            grok_client_id: env::var("GROK_AUTH_CLIENT_ID")
                .unwrap_or_else(|_| "b1a00492-073a-47ea-816f-4c329264a828".to_owned()),
            grok_client_version: env::var("GROK_CLIENT_VERSION")
                .unwrap_or_else(|_| "1.0.30".to_owned()),
            groq_api_url: env::var("GROQ_API_URL")
                .unwrap_or_else(|_| "https://api.groq.com/openai/v1".to_owned())
                .trim_end_matches('/')
                .to_owned(),
            chatgpt_codex_models_url: env::var("CHATGPT_CODEX_MODELS_URL")
                .unwrap_or_else(|_| "https://chatgpt.com/backend-api/codex/models".to_owned()),
            claude_models_url: env::var("CLAUDE_MODELS_URL")
                .unwrap_or_else(|_| "https://api.anthropic.com/v1/models?limit=1000".to_owned()),
            deepseek_api_url: env::var("DEEPSEEK_API_URL")
                .unwrap_or_else(|_| "https://api.deepseek.com".to_owned())
                .trim_end_matches('/')
                .to_owned(),
        })
    }
}

#[cfg(test)]
impl Default for AppConfig {
    fn default() -> Self {
        Self {
            client_ip_header: HeaderName::from_static("x-real-ip"),
            cookie_secure: false,
            cookie_name_suffix: String::new(),
            credential_encryption_key: [7; 32],
            stock_encryption_key: Some([9; 32]),
            frontend_origin: HeaderValue::from_static("http://localhost:5173"),
            shop_keys: Vec::new(),
            icon_storage: None,
            telegram_adapter_url: None,
            trust_proxy_headers: false,
            service_test_top_up: false,
            stripe_secret_key: None,
            stripe_webhook_secret: None,
            stripe_api_url: "https://api.stripe.com".to_owned(),
            codex_client_version: "0.156.0".to_owned(),
            codex_issuer: "https://auth.openai.com".to_owned(),
            claude_authorize_url: "https://claude.com/cai/oauth/authorize".to_owned(),
            claude_client_version: "2.1.223".to_owned(),
            claude_profile_url: "https://api.anthropic.com/api/oauth/profile".to_owned(),
            claude_redirect_url: "https://platform.claude.com/oauth/code/callback".to_owned(),
            claude_token_url: "https://platform.claude.com/v1/oauth/token".to_owned(),
            gemini_authorize_url: "https://accounts.google.com/o/oauth2/auth".to_owned(),
            gemini_client_id:
                "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
                    .to_owned(),
            gemini_client_secret: "test-gemini-client-secret".to_owned(),
            gemini_code_assist_url: "https://daily-cloudcode-pa.googleapis.com".to_owned(),
            gemini_redirect_url: "https://antigravity.google/oauth-callback".to_owned(),
            gemini_token_url: "https://oauth2.googleapis.com/token".to_owned(),
            gemini_userinfo_url: "https://www.googleapis.com/oauth2/v2/userinfo".to_owned(),
            grok_issuer: "https://auth.x.ai".to_owned(),
            grok_client_id: "b1a00492-073a-47ea-816f-4c329264a828".to_owned(),
            grok_client_version: "1.0.30".to_owned(),
            deepseek_api_url: "https://api.deepseek.com".to_owned(),
            groq_api_url: "https://api.groq.com/openai/v1".to_owned(),
            chatgpt_codex_models_url: "https://chatgpt.com/backend-api/codex/models".to_owned(),
            claude_models_url: "https://api.anthropic.com/v1/models?limit=1000".to_owned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AppConfig, ShopKey, TELEGRAM_KEY_NAME, parse_icon_storage, parse_shop_keys};

    const KEY_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const KEY_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn names(keys: &[ShopKey]) -> Vec<&str> {
        keys.iter().map(|shop| shop.name.as_str()).collect()
    }

    #[test]
    fn shop_keys_are_read_as_name_and_key_pairs() {
        let (keys, problems) = parse_shop_keys(&format!(" telegram:{KEY_A} , shop_1:{KEY_B},, "));

        assert!(problems.is_empty());
        assert_eq!(names(&keys), ["telegram", "shop_1"]);
        assert_eq!(keys[1].key, KEY_B.as_bytes());
    }

    #[test]
    fn a_name_may_be_a_domain() {
        let (keys, problems) = parse_shop_keys(&format!("shopwatcher.org:{KEY_A}"));

        assert!(problems.is_empty());
        assert_eq!(names(&keys), ["shopwatcher.org"]);
    }

    #[test]
    fn an_unset_list_issues_nothing_and_says_nothing() {
        let (keys, problems) = parse_shop_keys("");

        assert!(keys.is_empty());
        assert!(problems.is_empty());
    }

    #[test]
    fn a_bad_entry_is_left_out_and_the_good_ones_stay() {
        let (keys, problems) =
            parse_shop_keys(&format!("no-colon,Shop_1:{KEY_A},short:abc,shop_2:{KEY_B}"));

        assert_eq!(names(&keys), ["shop_2"]);
        assert_eq!(problems.len(), 3);
    }

    #[test]
    fn a_repeated_name_or_key_keeps_only_the_first() {
        let (keys, problems) =
            parse_shop_keys(&format!("shop_1:{KEY_A},shop_1:{KEY_B},shop_2:{KEY_A}"));

        assert_eq!(names(&keys), ["shop_1"]);
        assert_eq!(problems.len(), 2);
    }

    #[test]
    fn a_problem_never_repeats_the_key() {
        let (_, problems) = parse_shop_keys(&format!("shop_1:{KEY_A},shop_1:{KEY_B},short:abc"));

        assert!(
            problems
                .iter()
                .all(|problem| !problem.contains(KEY_A) && !problem.contains(KEY_B))
        );
    }

    #[test]
    fn the_telegram_key_is_the_entry_named_telegram() {
        let config = AppConfig {
            shop_keys: parse_shop_keys(&format!(
                "{TELEGRAM_KEY_NAME}:{KEY_A},shopwatcher.org:{KEY_B}"
            ))
            .0,
            ..AppConfig::default()
        };

        assert_eq!(config.telegram_key(), Some(KEY_A.as_bytes()));
        assert_eq!(config.issued_keys().count(), 2);
        assert_eq!(AppConfig::default().telegram_key(), None);
    }

    const SECRET: &str = "r2-secret-that-must-never-be-logged";

    fn r2(overrides: &[(&str, Option<&str>)]) -> (Option<super::IconStorage>, Vec<String>) {
        parse_icon_storage(|name| {
            if let Some((_, value)) = overrides.iter().find(|(key, _)| *key == name) {
                return value.map(str::to_owned);
            }

            Some(
                match name {
                    "R2_ACCOUNT_ID" => "0123abcd",
                    "R2_ACCESS_KEY_ID" => "key-id-1",
                    "R2_SECRET_ACCESS_KEY" => SECRET,
                    "R2_BUCKET" => "hub-william-icons",
                    _ => "https://pub-example.r2.dev/",
                }
                .to_owned(),
            )
        })
    }

    #[test]
    fn icon_storage_is_read_from_the_five_variables() {
        let (storage, problems) = r2(&[]);
        let storage = storage.expect("complete settings are used");

        assert!(problems.is_empty());
        assert_eq!(storage.account_id, "0123abcd");
        assert_eq!(storage.bucket, "hub-william-icons");
        assert_eq!(storage.public_url, "https://pub-example.r2.dev");
    }

    #[test]
    fn no_icon_storage_variables_means_no_storage_and_no_complaint() {
        let (storage, problems) = parse_icon_storage(|_| None);

        assert!(storage.is_none());
        assert!(problems.is_empty());
    }

    #[test]
    fn a_half_filled_icon_storage_is_off_and_names_what_is_missing() {
        let (storage, problems) = r2(&[("R2_BUCKET", None), ("R2_PUBLIC_URL", None)]);

        assert!(storage.is_none());
        assert_eq!(problems, ["R2_BUCKET, R2_PUBLIC_URL must be set as well"]);
    }

    #[test]
    fn a_value_that_cannot_be_used_turns_icon_storage_off() {
        for (name, value) in [
            ("R2_ACCOUNT_ID", "not an account"),
            ("R2_ACCESS_KEY_ID", "has space"),
            ("R2_BUCKET", "Upper"),
            ("R2_BUCKET", "-leading"),
            ("R2_BUCKET", "ab"),
            ("R2_PUBLIC_URL", "http://pub-example.r2.dev"),
            ("R2_PUBLIC_URL", "https://pub-example.r2.dev/?x=1"),
            ("R2_PUBLIC_URL", "https://user:pass@pub-example.r2.dev"),
            ("R2_PUBLIC_URL", "pub-example.r2.dev"),
        ] {
            let (storage, problems) = r2(&[(name, Some(value))]);

            assert!(storage.is_none(), "{name}={value} was accepted");
            assert_eq!(problems.len(), 1, "{name}={value}");
        }
    }

    #[test]
    fn an_icon_storage_problem_never_repeats_the_secret() {
        let (_, problems) = r2(&[
            ("R2_SECRET_ACCESS_KEY", Some("secret with spaces")),
            ("R2_BUCKET", Some("Bad Bucket")),
        ]);

        assert!(!problems.is_empty());
        assert!(
            problems
                .iter()
                .all(|problem| !problem.contains("secret with spaces") && !problem.contains(SECRET))
        );
    }
}
