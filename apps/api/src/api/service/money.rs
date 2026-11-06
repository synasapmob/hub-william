//! Prices and the arithmetic on them. Every amount is an integer number of
//! micro-dollars (1 USD = 1,000,000), so nothing is ever rounded as a float.

pub(super) const MICRO_PER_DOLLAR: i64 = 1_000_000;
const TOKENS_PER_PRICE_UNIT: i64 = 1_000_000;

/// The price of one million tokens, in micro-dollars, by kind of token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Price {
    pub(super) input: i64,
    pub(super) cached: i64,
    pub(super) output: i64,
}

/// The token counts a provider reported for one request. A count the provider
/// did not report is none, and costs nothing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Tokens {
    /// All input tokens, the cached ones included.
    pub(crate) input: Option<i64>,
    pub(crate) output: Option<i64>,
    pub(crate) cached: Option<i64>,
}

/// What a request costs, in micro-dollars, rounded up so the price is never
/// undercut: the new input tokens (the input less the cached ones), the cached
/// tokens and the output tokens, each at its own price. None when the amount
/// does not fit.
pub(super) fn request_cost_micro(tokens: Tokens, price: Price) -> Option<i64> {
    let input = tokens.input.unwrap_or(0).max(0);
    let cached = tokens.cached.unwrap_or(0).max(0).min(input);
    let output = tokens.output.unwrap_or(0).max(0);
    let fresh = input - cached;
    let total = i128::from(fresh) * i128::from(price.input)
        + i128::from(cached) * i128::from(price.cached)
        + i128::from(output) * i128::from(price.output);
    let unit = i128::from(TOKENS_PER_PRICE_UNIT);

    i64::try_from((total + unit - 1) / unit).ok()
}
