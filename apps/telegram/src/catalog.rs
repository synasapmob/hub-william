use crate::language::Localized;

/// The first level of the shop. Buyers pick a provider, then a package, so a
/// long line-up never arrives as one wall of buttons.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Provider {
    pub icon: &'static str,
    pub id: &'static str,
    pub name: &'static str,
}

/// One purchasable package. `variant` carries the activation label that is only
/// set on the packages sold as an own-account activation, and `warranty` is a
/// single code — a package sold with two warranties is two packages.
#[derive(Clone, Copy)]
pub struct CatalogItem {
    pub available: u32,
    pub detail: Option<&'static str>,
    pub id: &'static str,
    pub plan: &'static str,
    pub provider: Provider,
    pub tiers: &'static [PriceTier],
    pub variant: Option<&'static str>,
    pub warranty: Warranty,
    pub warranty_note: Localized,
}

/// Warranty codes are customer-facing and stable: they appear on every
/// catalogue row and must keep meaning the same across the shop.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Warranty {
    Full,
    None,
    SevenDays,
}

#[derive(Clone, Copy)]
pub struct PriceTier {
    pub minimum_quantity: u32,
    /// Đồng, kept as `i64` so it matches the API's order columns end to end.
    pub price: i64,
}

pub const CHATGPT: Provider = Provider {
    icon: "🟢",
    id: "chatgpt",
    name: "ChatGPT",
};

pub const CLAUDE: Provider = Provider {
    icon: "🟠",
    id: "claude",
    name: "Claude",
};

pub const GROK: Provider = Provider {
    icon: "⚫",
    id: "grok",
    name: "Grok",
};

pub const PROVIDERS: [Provider; 3] = [CHATGPT, CLAUDE, GROK];

impl CatalogItem {
    pub fn title(self) -> String {
        let mut title = format!("{} {}", self.provider.name, self.plan);
        if let Some(variant) = self.variant {
            title.push_str(" (");
            title.push_str(variant);
            title.push(')');
        }
        if let Some(detail) = self.detail {
            title.push_str(" · ");
            title.push_str(detail);
        }
        title
    }

    pub fn base_price(self) -> i64 {
        self.unit_price(1)
    }

    pub fn unit_price(self, quantity: u32) -> i64 {
        self.tiers
            .iter()
            .filter(|tier| tier.minimum_quantity <= quantity)
            .max_by_key(|tier| tier.minimum_quantity)
            .or_else(|| self.tiers.first())
            .map(|tier| tier.price)
            .unwrap_or_default()
    }

    pub fn is_available(self) -> bool {
        self.available > 0
    }
}

impl Warranty {
    pub fn code(self) -> &'static str {
        match self {
            Self::Full => "WF",
            Self::None => "NW",
            Self::SevenDays => "W7D",
        }
    }
}

const LOGIN_CHECK_WARRANTY: Localized = Localized {
    english: "Warranty is a login check within 1 hour (after that hour there is no warranty under any circumstance).",
    vietnamese: "Bảo hành login check 1 tiếng (sau 1 tiếng kể từ khi mua không bảo hành mọi trường hợp)",
};

const OWN_ACCOUNT_WARRANTY: Localized = Localized {
    english: "Activated straight on your own account, with a full warranty for the whole term.",
    vietnamese: "Active trực tiếp trên tài khoản chính chủ của bạn, bảo hành đầy đủ trọn thời hạn.",
};

pub const ITEMS: [CatalogItem; 5] = [
    CatalogItem {
        available: 53,
        detail: Some("1M"),
        id: "claude-max-x20",
        plan: "MAX X20",
        provider: CLAUDE,
        tiers: &[PriceTier {
            minimum_quantity: 1,
            price: 135_000,
        }],
        variant: Some("Personal"),
        warranty: Warranty::Full,
        warranty_note: OWN_ACCOUNT_WARRANTY,
    },
    CatalogItem {
        available: 27,
        detail: None,
        id: "claude-max-x5",
        plan: "MAX X5",
        provider: CLAUDE,
        tiers: &[PriceTier {
            minimum_quantity: 1,
            price: 79_000,
        }],
        variant: None,
        warranty: Warranty::SevenDays,
        warranty_note: LOGIN_CHECK_WARRANTY,
    },
    CatalogItem {
        available: 41,
        detail: None,
        id: "claude-pro",
        plan: "Pro",
        provider: CLAUDE,
        tiers: &[PriceTier {
            minimum_quantity: 1,
            price: 49_000,
        }],
        variant: None,
        warranty: Warranty::None,
        warranty_note: LOGIN_CHECK_WARRANTY,
    },
    CatalogItem {
        available: 12,
        detail: None,
        id: "chatgpt-plus",
        plan: "Plus",
        provider: CHATGPT,
        tiers: &[PriceTier {
            minimum_quantity: 1,
            price: 299_000,
        }],
        variant: Some("Personal"),
        warranty: Warranty::SevenDays,
        warranty_note: LOGIN_CHECK_WARRANTY,
    },
    CatalogItem {
        available: 0,
        detail: None,
        id: "grok-supergrok",
        plan: "SuperGrok",
        provider: GROK,
        tiers: &[PriceTier {
            minimum_quantity: 1,
            price: 259_000,
        }],
        variant: Some("Personal"),
        warranty: Warranty::None,
        warranty_note: LOGIN_CHECK_WARRANTY,
    },
];

pub fn find(id: &str) -> Option<CatalogItem> {
    ITEMS.into_iter().find(|item| item.id == id)
}

pub fn provider(id: &str) -> Option<Provider> {
    PROVIDERS.into_iter().find(|provider| provider.id == id)
}

pub fn items_for(provider: Provider) -> impl Iterator<Item = CatalogItem> {
    ITEMS
        .into_iter()
        .filter(move |item| item.provider.id == provider.id)
}

/// Groups an amount in Vietnamese đồng with thousands separators, without a
/// currency symbol so each screen can pick `đ` or `₫` itself.
pub fn format_amount(amount: i64) -> String {
    let digits = amount.to_string();
    let mut formatted = String::with_capacity(digits.len() + digits.len() / 3);

    for (index, digit) in digits.char_indices() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            formatted.push(',');
        }
        formatted.push(digit);
    }

    formatted
}

#[cfg(test)]
mod tests {
    use super::{
        CLAUDE, CatalogItem, GROK, ITEMS, PROVIDERS, PriceTier, Warranty, find, format_amount,
        items_for, provider,
    };
    use crate::language::Localized;

    #[test]
    fn a_title_only_renders_the_parts_a_package_actually_has() {
        assert_eq!(
            find("claude-max-x20").expect("seeded package").title(),
            "Claude MAX X20 (Personal) · 1M"
        );
        assert_eq!(
            find("claude-pro").expect("seeded package").title(),
            "Claude Pro"
        );
    }

    #[test]
    fn a_package_carries_exactly_one_warranty_code() {
        assert_eq!(
            find("claude-max-x20")
                .expect("seeded package")
                .warranty
                .code(),
            "WF"
        );
        assert_eq!(
            find("claude-max-x5")
                .expect("seeded package")
                .warranty
                .code(),
            "W7D"
        );
        assert_eq!(
            find("claude-pro").expect("seeded package").warranty.code(),
            "NW"
        );
    }

    #[test]
    fn a_provider_is_resolved_by_id_and_owns_its_packages() {
        assert_eq!(provider("claude"), Some(CLAUDE));
        assert_eq!(provider("gemini"), None);

        let claude = items_for(CLAUDE).map(|item| item.id).collect::<Vec<_>>();
        assert_eq!(claude, ["claude-max-x20", "claude-max-x5", "claude-pro"]);
        assert_eq!(items_for(GROK).count(), 1);
    }

    #[test]
    fn every_package_belongs_to_a_listed_provider() {
        for item in ITEMS {
            assert!(
                PROVIDERS.iter().any(|known| known.id == item.provider.id),
                "{} points at an unlisted provider",
                item.id
            );
        }
    }

    #[test]
    fn a_unit_price_uses_the_highest_tier_the_quantity_reaches() {
        let item = CatalogItem {
            tiers: &[
                PriceTier {
                    minimum_quantity: 1,
                    price: 159_000,
                },
                PriceTier {
                    minimum_quantity: 5,
                    price: 149_000,
                },
            ],
            ..find("claude-pro").expect("seeded package")
        };

        assert_eq!(item.unit_price(1), 159_000);
        assert_eq!(item.unit_price(4), 159_000);
        assert_eq!(item.unit_price(5), 149_000);
        assert_eq!(item.unit_price(50), 149_000);
    }

    #[test]
    fn a_quantity_below_every_tier_still_prices_from_the_first_tier() {
        let item = CatalogItem {
            tiers: &[PriceTier {
                minimum_quantity: 2,
                price: 99_000,
            }],
            ..find("claude-pro").expect("seeded package")
        };

        assert_eq!(item.unit_price(1), 99_000);
    }

    #[test]
    fn amounts_are_grouped_in_thousands() {
        assert_eq!(format_amount(0), "0");
        assert_eq!(format_amount(999), "999");
        assert_eq!(format_amount(135_000), "135,000");
        assert_eq!(format_amount(1_350_000), "1,350,000");
    }

    #[test]
    fn a_package_without_stock_is_not_available() {
        assert!(
            !find("grok-supergrok")
                .expect("seeded package")
                .is_available()
        );
        assert!(find("claude-pro").expect("seeded package").is_available());
    }

    #[test]
    fn every_package_is_priced_and_uniquely_identified() {
        for item in ITEMS {
            assert!(!item.tiers.is_empty(), "{} needs a price tier", item.id);
            assert_eq!(
                ITEMS.iter().filter(|other| other.id == item.id).count(),
                1,
                "{} is duplicated",
                item.id
            );
        }
    }

    #[test]
    fn warranty_codes_are_the_customer_facing_abbreviations() {
        assert_eq!(Warranty::Full.code(), "WF");
        assert_eq!(Warranty::None.code(), "NW");
        assert_eq!(Warranty::SevenDays.code(), "W7D");
    }

    #[test]
    fn a_warranty_note_is_written_in_both_languages() {
        for item in ITEMS {
            let Localized {
                english,
                vietnamese,
            } = item.warranty_note;
            assert!(!english.is_empty(), "{} needs an English note", item.id);
            assert!(
                !vietnamese.is_empty(),
                "{} needs a Vietnamese note",
                item.id
            );
        }
    }
}
