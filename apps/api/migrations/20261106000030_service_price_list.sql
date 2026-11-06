-- The price list becomes data: one row per model the service may sell, so the
-- dashboard can add, price and unlist models without a release. A request for a
-- model with no listed row is refused, and the Pricing page lists these rows.
--
-- `name` is what the Pricing page shows; `position` orders a model among its
-- agent's; `listed` false keeps a row without selling it.
ALTER TABLE service_model_prices
    ADD COLUMN name TEXT NOT NULL DEFAULT '',
    ADD COLUMN listed BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

-- The first rows are the agents' official API prices for one million tokens on
-- 2026-11-06, in micro-dollars. They are the reference a sale price is worked out
-- from, not what an account in the stock costs the platform (a subscription).
--
-- Prices that are due to change: gemini-4-argon doubles on 2026-12-01 (4 / 0.20 /
-- 20 dollars) and the Gemini 3.x flash models double on 2027-01-01. DeepSeek is
-- priced at its peak rate; off peak it is half. Long-context rates are not
-- applied.
--
-- Not listed until their price is settled: gemini-3.7-flash has no official
-- price, and the three models an Antigravity account serves for Gemini belong to
-- other makers (claude-sonnet-4-6, claude-opus-4-6-thinking at Anthropic's price
-- and gpt-oss-120b at Groq's). Where no cached price was found the cached price is
-- the input price.
INSERT INTO service_model_prices
    (provider, model, name, listed, position,
     input_micro_per_million, cached_micro_per_million, output_micro_per_million)
VALUES
    ('chatgpt', 'gpt-6-astra', 'GPT-6 Astra', TRUE, 1, 10000000, 1000000, 50000000),
    ('chatgpt', 'gpt-6-sol', 'GPT-6 Sol', TRUE, 2, 2000000, 200000, 10000000),
    ('chatgpt', 'gpt-6-luna', 'GPT-6 Luna', TRUE, 3, 100000, 10000, 500000),
    ('chatgpt', 'gpt-5.6-sol', 'GPT-5.6 Sol', TRUE, 4, 4000000, 400000, 20000000),
    ('chatgpt', 'gpt-5.6-terra', 'GPT-5.6 Terra', TRUE, 5, 2000000, 200000, 12000000),
    ('chatgpt', 'gpt-5.6-luna', 'GPT-5.6 Luna', TRUE, 6, 200000, 20000, 1200000),
    ('gemini', 'gemini-4-argon', 'gemini-4-argon', TRUE, 1, 2000000, 100000, 10000000),
    ('gemini', 'gemini-3.8-flash', 'gemini-3.8-flash', TRUE, 2, 750000, 75000, 3750000),
    ('gemini', 'gemini-3.7-flash', 'gemini-3.7-flash', FALSE, 3, 750000, 75000, 3750000),
    ('gemini', 'gemini-3.6-flash', 'gemini-3.6-flash', TRUE, 4, 750000, 75000, 3750000),
    ('gemini', 'gemini-3.1-pro', 'gemini-3.1-pro', TRUE, 5, 2000000, 200000, 12000000),
    ('gemini', 'claude-sonnet-4-6', 'claude-sonnet-4-6', FALSE, 6, 3000000, 300000, 15000000),
    ('gemini', 'claude-opus-4-6-thinking', 'claude-opus-4-6-thinking', FALSE, 7, 5000000, 500000, 25000000),
    ('gemini', 'gpt-oss-120b', 'gpt-oss-120b', FALSE, 8, 150000, 150000, 600000),
    ('claude', 'claude-fable-5-1', 'Claude Fable 5.1', TRUE, 1, 10000000, 250000, 50000000),
    ('claude', 'claude-opus-5-5', 'Claude Opus 5.5', TRUE, 2, 4000000, 200000, 20000000),
    ('claude', 'claude-sonnet-5', 'Claude Sonnet 5', TRUE, 3, 2000000, 200000, 10000000),
    ('claude', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', TRUE, 4, 1000000, 100000, 5000000),
    ('deepseek', 'deepseek-flash', 'DeepSeek Flash', TRUE, 1, 300000, 6000, 1200000),
    ('deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', TRUE, 2, 1320000, 44000, 3960000),
    ('grok', 'grok-4.7', 'Grok 4.7', TRUE, 1, 2000000, 500000, 6000000),
    ('groq', 'qwen/qwen3.8-27b', 'Qwen 3.8 27B', TRUE, 1, 800000, 800000, 4000000),
    ('groq', 'openai/gpt-oss-20b', 'GPT OSS 20B', TRUE, 2, 75000, 75000, 300000),
    ('groq', 'openai/gpt-oss-120b', 'GPT OSS 120B', TRUE, 3, 150000, 150000, 600000);
