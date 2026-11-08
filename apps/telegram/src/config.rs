use std::{env, fmt};

use reqwest::Url;

const DEFAULT_OWNER_USERNAME: &str = "synasapmob";
const OWNER_USERNAME: &str = "TELEGRAM_USERNAME_OWNER";
const DEFAULT_MEMO_PREFIX: &str = "MOT NGAY VUI VE";
const DEFAULT_USDT_NETWORK: &str = "TRC20";
const SERVICE_TOKEN: &str = "TELEGRAM_SERVICE_TOKEN";
const FORMER_SERVICE_TOKEN: &str = "HUB_API_SERVICE_TOKEN";
const MAXIMUM_MEMO_PREFIX_CHARACTERS: usize = 32;
const PAYMENT_QR_URL: &str = "TELEGRAM_PAYMENT_QR_URL";

#[derive(Clone)]
pub struct AppConfig {
    /// Where a restock is announced. Posting to one channel keeps the bot clear
    /// of Telegram's bulk-message limits and of anyone blocking it.
    pub announce_chat_id: Option<String>,
    pub api_internal_url: Url,
    pub api_service_token: String,
    pub bot_token: String,
    /// Needed for the "Mua ngay" deep link on an announcement.
    pub bot_username: Option<String>,
    pub owner: Owner,
    pub payment: PaymentConfig,
    pub sepay_api_key: Option<String>,
    pub telegram_api_base_url: Url,
    pub webhook_secret: Vec<u8>,
}

/// Receiving accounts for the checkout panels. Both methods are optional so the
/// adapter still boots before a shop account exists; an unconfigured method
/// says so to the buyer instead of showing invented payment details.
#[derive(Clone, Default)]
pub struct PaymentConfig {
    pub bank: Option<BankAccount>,
    pub memo_prefix: String,
    pub usdt: Option<UsdtWallet>,
}

/// The one Telegram username that runs the shop. It decides who may use the
/// owner side of `/catalog`, and it is the handle a buyer is told to contact. A
/// username belongs to one account at a time, so no numeric ID is kept beside it.
#[derive(Clone)]
pub struct Owner {
    username: String,
}

impl Owner {
    /// Telegram usernames are 5-32 letters, digits or underscores. Anything else,
    /// such as a list left over from a comma-separated setting, is refused rather
    /// than quietly locking the owner out.
    pub fn parse(value: &str) -> Result<Self, ConfigError> {
        let username = value.trim().trim_start_matches('@');

        if !(5..=32).contains(&username.len())
            || !username
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
        {
            return Err(ConfigError(format!(
                "{OWNER_USERNAME} must be one Telegram username of 5-32 letters, digits or underscores"
            )));
        }

        Ok(Self {
            username: username.to_lowercase(),
        })
    }

    pub fn includes(&self, username: Option<&str>) -> bool {
        username.is_some_and(|username| {
            username
                .trim_start_matches('@')
                .eq_ignore_ascii_case(&self.username)
        })
    }

    /// How the owner is written in a message, so a buyer can tap it.
    pub fn handle(&self) -> String {
        format!("@{}", self.username)
    }
}

/// The shop's receiving account, read out of its VietQR link.
#[derive(Clone)]
pub struct BankAccount {
    pub holder: String,
    pub name: String,
    pub number: String,
    /// The link as configured. Each order's amount and note go on a copy of it.
    pub qr: Url,
}

#[derive(Clone)]
pub struct UsdtWallet {
    pub address: String,
    pub network: String,
    pub vnd_rate: i64,
}

#[derive(Debug)]
pub struct ConfigError(String);

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

impl AppConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let api_internal_url =
            env::var("HUB_API_INTERNAL_URL").unwrap_or_else(|_| "http://localhost:8080".to_owned());
        let api_internal_url = Url::parse(&api_internal_url)
            .map_err(|_| ConfigError("HUB_API_INTERNAL_URL must be a valid HTTP URL".to_owned()))?;
        let api_service_token = service_token(|name| env::var(name).ok())?;
        let bot_token = required_secret("TELEGRAM_BOT_TOKEN")?;
        let webhook_secret = required_secret("TELEGRAM_WEBHOOK_SECRET")?;
        let telegram_api_base_url = env::var("TELEGRAM_API_BASE_URL")
            .unwrap_or_else(|_| "https://api.telegram.org/".to_owned());
        let telegram_api_base_url = Url::parse(&telegram_api_base_url).map_err(|_| {
            ConfigError("TELEGRAM_API_BASE_URL must be a valid HTTP URL".to_owned())
        })?;

        if !webhook_secret
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
            || webhook_secret.len() > 256
        {
            return Err(ConfigError(
                "TELEGRAM_WEBHOOK_SECRET must use 1-256 letters, numbers, underscores, or hyphens"
                    .to_owned(),
            ));
        }

        Ok(Self {
            announce_chat_id: optional("TELEGRAM_ANNOUNCE_CHAT_ID"),
            api_internal_url,
            api_service_token,
            bot_token,
            bot_username: optional("TELEGRAM_BOT_USERNAME")
                .map(|username| username.trim_start_matches('@').to_owned()),
            owner: Owner::parse(
                &optional(OWNER_USERNAME).unwrap_or_else(|| DEFAULT_OWNER_USERNAME.to_owned()),
            )?,
            payment: PaymentConfig::from_env()?,
            sepay_api_key: optional("SEPAY_API_KEY"),
            telegram_api_base_url,
            webhook_secret: webhook_secret.into_bytes(),
        })
    }
}

impl PaymentConfig {
    fn from_env() -> Result<Self, ConfigError> {
        Ok(Self {
            bank: bank_account(optional(PAYMENT_QR_URL))?,
            memo_prefix: memo_prefix(optional("TELEGRAM_PAYMENT_MEMO_PREFIX"))?,
            usdt: usdt_wallet(
                optional("TELEGRAM_PAYMENT_USDT_ADDRESS"),
                optional("TELEGRAM_PAYMENT_USDT_NETWORK"),
                optional("TELEGRAM_PAYMENT_USDT_VND_RATE"),
            )?,
        })
    }
}

/// The transfer memo is typed into a bank app, so it stays inside the ASCII
/// subset every Vietnamese bank accepts in a transfer description.
fn memo_prefix(configured: Option<String>) -> Result<String, ConfigError> {
    let prefix = configured
        .unwrap_or_else(|| DEFAULT_MEMO_PREFIX.to_owned())
        .to_ascii_uppercase();

    if prefix.is_empty()
        || prefix.chars().count() > MAXIMUM_MEMO_PREFIX_CHARACTERS
        || !prefix
            .chars()
            .all(|character| character.is_ascii_uppercase() || character == ' ')
    {
        return Err(ConfigError(format!(
            "TELEGRAM_PAYMENT_MEMO_PREFIX must use 1-{MAXIMUM_MEMO_PREFIX_CHARACTERS} letters or spaces"
        )));
    }

    Ok(prefix)
}

/// The receiving account is one VietQR link, for example
/// `https://vietqr.app/img?bank=MBBank&acc=0123456789&holder=NGUYEN VAN A`. Its
/// bank, account and holder are shown on the VND panel, and every order puts its
/// own amount and note on a copy of it, so a `des` or `amount` in the link
/// itself is never used.
fn bank_account(link: Option<String>) -> Result<Option<BankAccount>, ConfigError> {
    let Some(link) = link else {
        return Ok(None);
    };
    let invalid = |reason: &str| ConfigError(format!("{PAYMENT_QR_URL} {reason}"));

    let qr = Url::parse(&link)
        .ok()
        .filter(|url| url.scheme() == "https")
        .ok_or_else(|| invalid("must be a valid HTTPS URL"))?;
    let field = |name: &str| {
        qr.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    let (Some(name), Some(number), Some(holder)) = (field("bank"), field("acc"), field("holder"))
    else {
        return Err(invalid("must carry bank, acc and holder"));
    };

    if !number.chars().all(|character| character.is_ascii_digit()) {
        return Err(invalid("must have an acc of digits only"));
    }

    Ok(Some(BankAccount {
        holder: holder.to_uppercase(),
        name: name.to_uppercase(),
        number,
        qr,
    }))
}

fn usdt_wallet(
    address: Option<String>,
    network: Option<String>,
    vnd_rate: Option<String>,
) -> Result<Option<UsdtWallet>, ConfigError> {
    let (address, vnd_rate) = match (address, vnd_rate) {
        (Some(address), Some(vnd_rate)) => (address, vnd_rate),
        (None, None) => return Ok(None),
        _ => {
            return Err(ConfigError(
                "TELEGRAM_PAYMENT_USDT_ADDRESS and TELEGRAM_PAYMENT_USDT_VND_RATE must be set together".to_owned(),
            ));
        }
    };

    let vnd_rate = vnd_rate
        .parse::<i64>()
        .ok()
        .filter(|rate| *rate > 0)
        .ok_or_else(|| {
            ConfigError(
                "TELEGRAM_PAYMENT_USDT_VND_RATE must be the positive number of đồng per USDT"
                    .to_owned(),
            )
        })?;

    Ok(Some(UsdtWallet {
        address,
        network: network.unwrap_or_else(|| DEFAULT_USDT_NETWORK.to_owned()),
        vnd_rate,
    }))
}

fn optional(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// The secret shared with the API. Both apps call it `TELEGRAM_SERVICE_TOKEN`. The
/// adapter used to call it `HUB_API_SERVICE_TOKEN`, and that name is still read when
/// the new one is not set, so a deployment is not broken by the rename.
fn service_token(lookup: impl Fn(&str) -> Option<String>) -> Result<String, ConfigError> {
    let set = |name: &str| lookup(name).filter(|value| !value.trim().is_empty());

    set(SERVICE_TOKEN)
        .or_else(|| {
            let former = set(FORMER_SERVICE_TOKEN);

            if former.is_some() {
                eprintln!(
                    "{FORMER_SERVICE_TOKEN} is the former name of {SERVICE_TOKEN}; rename it"
                );
            }

            former
        })
        .ok_or_else(|| ConfigError(format!("{SERVICE_TOKEN} must be set")))
}

fn required_secret(name: &str) -> Result<String, ConfigError> {
    let value = env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ConfigError(format!("{name} must be set")))?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::{
        DEFAULT_MEMO_PREFIX, DEFAULT_OWNER_USERNAME, DEFAULT_USDT_NETWORK, Owner, bank_account,
        memo_prefix, service_token, usdt_wallet,
    };

    fn environment(
        pairs: &'static [(&'static str, &'static str)],
    ) -> impl Fn(&str) -> Option<String> {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        }
    }

    #[test]
    fn the_service_token_is_read_from_the_name_the_api_uses() {
        let lookup = environment(&[("TELEGRAM_SERVICE_TOKEN", "shared-secret")]);

        assert_eq!(service_token(lookup).unwrap(), "shared-secret");
    }

    #[test]
    fn the_former_name_still_works_when_the_new_one_is_not_set() {
        let lookup = environment(&[("HUB_API_SERVICE_TOKEN", "shared-secret")]);

        assert_eq!(service_token(lookup).unwrap(), "shared-secret");
    }

    #[test]
    fn the_new_name_wins_when_both_are_set_and_a_blank_one_counts_as_unset() {
        let both = environment(&[
            ("TELEGRAM_SERVICE_TOKEN", "new-secret"),
            ("HUB_API_SERVICE_TOKEN", "old-secret"),
        ]);
        let blank = environment(&[
            ("TELEGRAM_SERVICE_TOKEN", "   "),
            ("HUB_API_SERVICE_TOKEN", "old-secret"),
        ]);

        assert_eq!(service_token(both).unwrap(), "new-secret");
        assert_eq!(service_token(blank).unwrap(), "old-secret");
    }

    #[test]
    fn without_either_name_the_error_asks_for_the_new_one() {
        let error = service_token(environment(&[])).unwrap_err();

        assert_eq!(error.0, "TELEGRAM_SERVICE_TOKEN must be set");
    }

    #[test]
    fn the_memo_prefix_defaults_and_normalizes_to_bank_safe_text() {
        assert_eq!(memo_prefix(None).unwrap(), DEFAULT_MEMO_PREFIX);
        assert_eq!(
            memo_prefix(Some("hub william".to_owned())).unwrap(),
            "HUB WILLIAM"
        );
        assert!(memo_prefix(Some("chuyển khoản".to_owned())).is_err());
        assert!(memo_prefix(Some("x".repeat(33))).is_err());
    }

    const FAKE_LINK: &str =
        "https://vietqr.app/img?bank=MBBank&acc=0123456789&holder=Nguyen Van A&showinfo=true";

    #[test]
    fn without_a_qr_link_there_is_no_bank_account() {
        assert!(bank_account(None).unwrap().is_none());
    }

    #[test]
    fn a_bank_account_is_read_from_the_link_and_displayed_in_upper_case() {
        let bank = bank_account(Some(FAKE_LINK.to_owned()))
            .unwrap()
            .expect("a configured bank account");

        assert_eq!(bank.name, "MBBANK");
        assert_eq!(bank.holder, "NGUYEN VAN A");
        assert_eq!(bank.number, "0123456789");
        // The link itself is kept as it was written.
        assert!(
            bank.qr
                .as_str()
                .starts_with("https://vietqr.app/img?bank=MBBank&acc=")
        );
    }

    #[test]
    fn a_qr_link_must_be_https_and_name_the_bank_the_account_and_the_holder() {
        for link in [
            "not a link",
            "http://vietqr.app/img?bank=MBBank&acc=0123456789&holder=NGUYEN",
            "https://vietqr.app/img?acc=0123456789&holder=NGUYEN",
            "https://vietqr.app/img?bank=MBBank&holder=NGUYEN",
            "https://vietqr.app/img?bank=MBBank&acc=0123456789",
            "https://vietqr.app/img?bank=MBBank&acc=0123456789&holder=%20",
        ] {
            assert!(bank_account(Some(link.to_owned())).is_err(), "{link}");
        }
    }

    #[test]
    fn a_bank_account_number_rejects_anything_but_digits() {
        assert!(
            bank_account(Some(
                "https://vietqr.app/img?bank=MBBank&acc=0123 4567&holder=NGUYEN".to_owned()
            ))
            .is_err()
        );
    }

    #[test]
    fn the_owner_is_recognised_by_username_in_any_case_with_or_without_the_at() {
        let owner = Owner::parse(" @Synasapmob ").unwrap();

        assert!(owner.includes(Some("synasapmob")));
        assert!(owner.includes(Some("@SYNASAPMOB")));
        assert!(!owner.includes(Some("someone_else")));
        assert!(!owner.includes(None));
        assert_eq!(owner.handle(), "@synasapmob");
    }

    #[test]
    fn the_owner_defaults_to_the_operator() {
        let owner = Owner::parse(DEFAULT_OWNER_USERNAME).unwrap();

        assert!(owner.includes(Some("synasapmob")));
        assert!(!owner.includes(Some("impostor")));
    }

    #[test]
    fn the_owner_must_be_one_valid_telegram_username() {
        for value in [
            "",
            "abcd",
            "first_owner,second_owner",
            "with space",
            &"a".repeat(33),
        ] {
            assert!(Owner::parse(value).is_err(), "{value:?}");
        }
    }

    #[test]
    fn a_usdt_wallet_needs_an_address_and_a_positive_rate() {
        assert!(usdt_wallet(None, None, None).unwrap().is_none());
        assert!(usdt_wallet(Some("TWallet".to_owned()), None, None).is_err());
        assert!(usdt_wallet(Some("TWallet".to_owned()), None, Some("0".to_owned())).is_err());

        let wallet = usdt_wallet(Some("TWallet".to_owned()), None, Some("26000".to_owned()))
            .unwrap()
            .expect("a fully configured wallet");

        assert_eq!(wallet.network, DEFAULT_USDT_NETWORK);
        assert_eq!(wallet.vnd_rate, 26_000);
    }
}
