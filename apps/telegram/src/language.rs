#[derive(Clone, Copy)]
pub enum Language {
    English,
    Vietnamese,
}

impl Language {
    pub fn code(self) -> &'static str {
        match self {
            Self::English => "en",
            Self::Vietnamese => "vi",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "en" => Some(Self::English),
            "vi" => Some(Self::Vietnamese),
            _ => None,
        }
    }

    pub fn pick(self, text: Localized) -> &'static str {
        match self {
            Self::English => text.english,
            Self::Vietnamese => text.vietnamese,
        }
    }
}

#[derive(Clone, Copy)]
pub struct Localized {
    pub english: &'static str,
    pub vietnamese: &'static str,
}
