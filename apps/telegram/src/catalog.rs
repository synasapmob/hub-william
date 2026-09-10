use serde::Deserialize;

use crate::language::Language;

/// The shop as `apps/api` owns it. Nothing here is compiled in any more: the
/// adapter reads the catalogue on every screen, so an owner's edit shows up
/// without a deploy.
#[derive(Clone, Debug, Deserialize)]
pub struct Catalogue {
    pub providers: Vec<Provider>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Provider {
    pub name: String,
    pub products: Vec<Product>,
    pub slug: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Product {
    pub available: i64,
    pub detail: Option<String>,
    pub hot: bool,
    pub listed: bool,
    pub plan: String,
    pub price_vnd: i64,
    pub provider_name: String,
    pub provider_slug: String,
    pub slug: String,
    pub variant: Option<String>,
    pub warranty: String,
    pub warranty_note_en: String,
    pub warranty_note_vi: String,
}

impl Catalogue {
    pub fn provider(&self, slug: &str) -> Option<&Provider> {
        self.providers.iter().find(|provider| provider.slug == slug)
    }

    pub fn products(&self) -> impl Iterator<Item = &Product> {
        self.providers
            .iter()
            .flat_map(|provider| &provider.products)
    }
}

impl Product {
    /// The plain name, which is what an order records.
    pub fn title(&self) -> String {
        let mut title = format!("{} {}", self.provider_name, self.plan);
        if let Some(variant) = self.variant.as_deref() {
            title.push_str(" (");
            title.push_str(variant);
            title.push(')');
        }
        if let Some(detail) = self.detail.as_deref() {
            title.push_str(" · ");
            title.push_str(detail);
        }
        title
    }

    /// The title as a shop row shows it. The flame is the only decoration a row
    /// carries, so an ordinary package stays bare and it keeps meaning
    /// something.
    pub fn headline(&self) -> String {
        match self.hot {
            true => format!("🔥 {}", self.title()),
            false => self.title(),
        }
    }

    pub fn warranty_note(&self, language: Language) -> &str {
        match language {
            Language::English => &self.warranty_note_en,
            Language::Vietnamese => &self.warranty_note_vi,
        }
    }

    pub fn is_available(&self) -> bool {
        self.available > 0
    }
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
    use super::{Catalogue, Product, Provider, format_amount};
    use crate::language::Language;

    #[test]
    fn a_title_only_renders_the_parts_a_product_actually_has() {
        assert_eq!(
            product("claude-max-x20", true).title(),
            "Claude MAX X20 (Personal) · 1M"
        );

        let bare = Product {
            detail: None,
            plan: "Pro".to_owned(),
            variant: None,
            ..product("claude-pro", false)
        };
        assert_eq!(bare.title(), "Claude Pro");
    }

    /// The flame is display only; an order has to record the plain title.
    #[test]
    fn only_a_hot_product_is_marked() {
        assert_eq!(
            product("claude-max-x20", true).headline(),
            "🔥 Claude MAX X20 (Personal) · 1M"
        );
        assert_eq!(
            product("claude-max-x20", false).headline(),
            "Claude MAX X20 (Personal) · 1M"
        );
        assert_eq!(
            product("claude-max-x20", true).title(),
            "Claude MAX X20 (Personal) · 1M"
        );
    }

    #[test]
    fn a_warranty_note_follows_the_reader() {
        let product = product("claude-pro", false);

        assert_eq!(product.warranty_note(Language::English), "note");
        assert_eq!(product.warranty_note(Language::Vietnamese), "ghi chú");
    }

    #[test]
    fn a_provider_is_found_by_slug() {
        let catalogue = Catalogue {
            providers: vec![Provider {
                name: "Claude".to_owned(),
                products: vec![product("claude-pro", false)],
                slug: "claude".to_owned(),
            }],
        };

        assert_eq!(
            catalogue
                .provider("claude")
                .map(|found| found.slug.as_str()),
            Some("claude")
        );
        assert!(catalogue.provider("gemini").is_none());
        assert_eq!(catalogue.products().count(), 1);
    }

    #[test]
    fn amounts_are_grouped_in_thousands() {
        assert_eq!(format_amount(0), "0");
        assert_eq!(format_amount(999), "999");
        assert_eq!(format_amount(135_000), "135,000");
        assert_eq!(format_amount(1_350_000), "1,350,000");
    }

    #[test]
    fn a_product_without_stock_is_not_available() {
        let sold_out = Product {
            available: 0,
            ..product("grok-supergrok", false)
        };

        assert!(!sold_out.is_available());
        assert!(product("claude-pro", false).is_available());
    }

    fn product(slug: &str, hot: bool) -> Product {
        Product {
            available: 53,
            detail: Some("1M".to_owned()),
            hot,
            listed: true,
            plan: "MAX X20".to_owned(),
            price_vnd: 135_000,
            provider_name: "Claude".to_owned(),
            provider_slug: "claude".to_owned(),
            slug: slug.to_owned(),
            variant: Some("Personal".to_owned()),
            warranty: "WF".to_owned(),
            warranty_note_en: "note".to_owned(),
            warranty_note_vi: "ghi chú".to_owned(),
        }
    }
}
