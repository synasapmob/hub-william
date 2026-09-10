use std::{env, fmt};

use reqwest::Url;

const DEFAULT_MEMO_PREFIX: &str = "CAM TIEN DI CHILL THOI";
const DEFAULT_USDT_NETWORK: &str = "TRC20";
const MAXIMUM_MEMO_PREFIX_CHARACTERS: usize = 32;

#[derive(Clone)]
pub struct AppConfig {
    pub api_internal_url: Url,
    pub api_service_token: String,
    pub bot_token: String,
    pub payment: PaymentConfig,
    /// This service's own public HTTPS origin. Telegram fetches the payment QR
    /// from it, so it must be reachable from the public internet.
    pub public_url: Option<Url>,
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

#[derive(Clone)]
pub struct BankAccount {
    pub holder: String,
    pub name: String,
    pub number: String,
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
        let api_service_token = required_secret("HUB_API_SERVICE_TOKEN")?;
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
            api_internal_url,
            api_service_token,
            bot_token,
            payment: PaymentConfig::from_env()?,
            public_url: public_url(
                optional("TELEGRAM_PUBLIC_URL").or_else(|| optional("TELEGRAM_WEBHOOK_URL")),
            )?,
            sepay_api_key: optional("SEPAY_API_KEY"),
            telegram_api_base_url,
            webhook_secret: webhook_secret.into_bytes(),
        })
    }
}

impl PaymentConfig {
    fn from_env() -> Result<Self, ConfigError> {
        Ok(Self {
            bank: bank_account(
                optional("TELEGRAM_PAYMENT_BANK_NAME"),
                optional("TELEGRAM_PAYMENT_ACCOUNT_HOLDER"),
                optional("TELEGRAM_PAYMENT_ACCOUNT_NUMBER"),
            )?,
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

/// The QR the buyer scans is a fixed image of this account, so the three fields
/// are only ever displayed — nothing is derived from them.
fn bank_account(
    name: Option<String>,
    holder: Option<String>,
    number: Option<String>,
) -> Result<Option<BankAccount>, ConfigError> {
    let (name, holder, number) = match (name, holder, number) {
        (Some(name), Some(holder), Some(number)) => (name, holder, number),
        (None, None, None) => return Ok(None),
        _ => {
            return Err(ConfigError(
                "TELEGRAM_PAYMENT_BANK_NAME, TELEGRAM_PAYMENT_ACCOUNT_HOLDER, and TELEGRAM_PAYMENT_ACCOUNT_NUMBER must be set together".to_owned(),
            ));
        }
    };

    if !number.chars().all(|character| character.is_ascii_digit()) {
        return Err(ConfigError(
            "TELEGRAM_PAYMENT_ACCOUNT_NUMBER must contain digits only".to_owned(),
        ));
    }

    Ok(Some(BankAccount {
        holder: holder.to_uppercase(),
        name: name.to_uppercase(),
        number,
    }))
}

fn public_url(configured: Option<String>) -> Result<Option<Url>, ConfigError> {
    configured
        .map(|value| {
            Url::parse(&value).map_err(|_| {
                ConfigError("TELEGRAM_PUBLIC_URL must be a valid HTTPS URL".to_owned())
            })
        })
        .transpose()
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
        DEFAULT_MEMO_PREFIX, DEFAULT_USDT_NETWORK, bank_account, memo_prefix, public_url,
        usdt_wallet,
    };

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

    #[test]
    fn a_bank_account_is_configured_completely_or_not_at_all() {
        assert!(bank_account(None, None, None).unwrap().is_none());
        match bank_account(Some("Techcombank".to_owned()), None, None) {
            Err(error) => assert!(error.to_string().contains("must be set together")),
            Ok(_) => panic!("a half-configured bank account should be rejected"),
        }
    }

    #[test]
    fn a_bank_account_is_displayed_in_upper_case() {
        let bank = bank_account(
            Some("techcombank".to_owned()),
            Some("trần văn sơn".to_owned()),
            Some("19036951867026".to_owned()),
        )
        .unwrap()
        .expect("a fully configured bank account");

        assert_eq!(bank.name, "TECHCOMBANK");
        assert_eq!(bank.holder, "TRẦN VĂN SƠN");
        assert_eq!(bank.number, "19036951867026");
    }

    #[test]
    fn a_bank_account_number_rejects_anything_but_digits() {
        assert!(
            bank_account(
                Some("Techcombank".to_owned()),
                Some("TRAN VAN SON".to_owned()),
                Some("1903 6951 8670 26".to_owned()),
            )
            .is_err()
        );
    }

    #[test]
    fn a_public_url_is_optional_but_must_parse() {
        assert!(public_url(None).unwrap().is_none());
        assert!(
            public_url(Some("https://telegram.example.test".to_owned()))
                .unwrap()
                .is_some()
        );
        assert!(public_url(Some("not a url".to_owned())).is_err());
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
