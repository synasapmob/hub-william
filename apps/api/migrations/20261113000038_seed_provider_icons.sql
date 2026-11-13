-- The six icons Hub William always had, now kept in the icon bucket: each agent starts
-- with the one that was uploaded for it, so a dashboard with the bucket set up shows
-- them without anyone choosing. A provider that already has an icon keeps its own.
-- The names are the pictures' own: a changed picture is a new name (see `api::dashboard::icons`).
INSERT INTO dashboard_provider_icons (provider, icon) VALUES
    ('chatgpt', 'icons/chatgpt-770d4f42.webp'),
    ('claude', 'icons/claude-3995378b.png'),
    ('deepseek', 'icons/deepseek-f5e23767.png'),
    ('gemini', 'icons/gemini-7a6ae22a.png'),
    ('grok', 'icons/grok-6d2ebb55.png'),
    ('groq', 'icons/groq-5524bc44.png')
ON CONFLICT (provider) DO NOTHING;
