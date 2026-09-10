use crate::{
    catalog::{CatalogItem, PROVIDERS, Provider, format_amount, items_for},
    checkout::{
        Order, OrderStatus, format_expiry, memo, providers_image_url, qr_image_url, usdt_amount,
    },
    config::AppConfig,
    language::{Language, Localized},
    telegram::{InlineKeyboardButton, InlineKeyboardMarkup, Reply, SendMessage, SendPhoto},
};

const LANGUAGE_PROMPT: &str = "Choose a language / Chọn ngôn ngữ";
const SUPPORT_HANDLE: &str = "@synasapmob";

pub fn language_picker(chat_id: i64) -> SendMessage {
    SendMessage::new(chat_id, LANGUAGE_PROMPT).with_keyboard(language_keyboard())
}

/// The shop opens on the provider marks the frontend uses, laid out in the same
/// order as the buttons under them.
pub fn menu(chat_id: i64, language: Language, config: &AppConfig) -> Reply {
    let text = menu_text(language);
    let keyboard = menu_keyboard();

    match config.public_url.as_ref().and_then(providers_image_url) {
        Some(photo) => SendPhoto::new(chat_id, photo, text)
            .with_keyboard(keyboard)
            .into(),
        // Without a public origin Telegram cannot fetch the marks, so the
        // providers go out as text rather than as a broken photo.
        None => SendMessage::new(chat_id, text)
            .with_keyboard(keyboard)
            .into(),
    }
}

pub fn provider(chat_id: i64, language: Language, provider: Provider) -> SendMessage {
    SendMessage::new(chat_id, provider_text(language, provider))
        .with_keyboard(provider_keyboard(language, provider))
}

pub fn quantity_prompt(chat_id: i64, language: Language, item: CatalogItem) -> SendMessage {
    SendMessage::new(chat_id, quantity_prompt_text(language, item))
        .with_keyboard(back_to_provider_keyboard(language, item.provider))
}

pub fn quantity_error(chat_id: i64, language: Language, item: CatalogItem) -> SendMessage {
    let available = item.available;
    if !item.is_available() {
        return SendMessage::new(
            chat_id,
            language.pick(Localized {
                english: "🔴 This package is sold out. Use /menu to pick another one.",
                vietnamese: "🔴 Gói này đã hết hàng. Dùng /menu để chọn gói khác.",
            }),
        )
        .with_keyboard(back_keyboard(language));
    }

    let text = match language {
        Language::English => {
            format!("⚠️ That quantity is not valid.\n\nSend a number from 1 to {available}.")
        }
        Language::Vietnamese => {
            format!("⚠️ Số lượng không hợp lệ.\n\nGửi một số từ 1 đến {available}.")
        }
    };
    SendMessage::new(chat_id, text)
}

pub fn payment_methods(chat_id: i64, language: Language, order: &Order) -> SendMessage {
    let title = &order.item_title;
    let quantity = order.quantity;
    let unit_price = format_amount(order.unit_price_vnd);
    let total = format_amount(order.total_vnd);
    let text = match language {
        Language::English => format!(
            "🧾 Order\n{title}\nQuantity: {quantity} × {unit_price}₫\nTotal: {total}₫\n\nPayment method:"
        ),
        Language::Vietnamese => format!(
            "🧾 Đơn hàng\n{title}\nSố lượng: {quantity} × {unit_price}₫\nTổng: {total}₫\n\nPhương thức thanh toán:"
        ),
    };

    SendMessage::new(chat_id, text).with_keyboard(InlineKeyboardMarkup {
        inline_keyboard: vec![
            vec![InlineKeyboardButton::callback(
                language.pick(Localized {
                    english: "💳 Pay in VND",
                    vietnamese: "💳 Chuyển Qua VND",
                }),
                format!("pay:vnd:{}", order.reference),
            )],
            vec![InlineKeyboardButton::callback(
                language.pick(Localized {
                    english: "₮ Pay in USDT",
                    vietnamese: "₮ Chuyển Qua USDT",
                }),
                format!("pay:usdt:{}", order.reference),
            )],
        ],
    })
}

/// The QR is a fixed image of the shop's account, so it carries no amount and
/// no note. Both have to be typed by the buyer, and the transfer note is what
/// SePay matches the order on — the caption says so in as many words.
pub fn bank_transfer(chat_id: i64, language: Language, config: &AppConfig, order: &Order) -> Reply {
    let Some(bank) = config.payment.bank.as_ref() else {
        return unconfigured_method(
            chat_id,
            language,
            order,
            Localized {
                english: "⚠️ Bank transfer is not configured yet.",
                vietnamese: "⚠️ Chuyển khoản ngân hàng chưa được cấu hình.",
            },
        )
        .into();
    };

    let transfer_memo = memo(&config.payment.memo_prefix, &order.reference);
    let total = format_amount(order.total_vnd);
    let expiry = format_expiry(order.expires_at);
    let caption = match language {
        Language::English => format!(
            "🏦 Bank transfer\n\n🏛️ Bank: {name}\n👤 Account name: {holder}\n💳 Account number: {number}\n💰 Amount: {total}₫\n📝 Transfer note: {transfer_memo}\n⚠️ A transfer sent with the wrong note needs manual handling and is charged $2 per transaction.\n⏳ Expires: {expiry}\n\n👆 Scan the QR above, then type the amount and the transfer note yourself.\n✅ The order is processed automatically once the payment arrives.",
            holder = bank.holder,
            name = bank.name,
            number = bank.number,
        ),
        Language::Vietnamese => format!(
            "🏦 Thanh toán chuyển khoản\n\n🏛️ Ngân hàng: {name}\n👤 Chủ TK: {holder}\n💳 Số TK: {number}\n💰 Số tiền: {total}₫\n📝 Nội dung CK: {transfer_memo}\n⚠️ Giao dịch chuyển sai cú pháp sẽ cần xử lý thủ công và bị tính phí $2/giao dịch.\n⏳ Hết hạn: {expiry}\n\n👆 Quét mã QR phía trên, rồi tự nhập số tiền và nội dung CK ở trên.\n✅ Đơn hàng xử lý tự động sau khi thanh toán.",
            holder = bank.holder,
            name = bank.name,
            number = bank.number,
        ),
    };

    let keyboard = watch_keyboard(language, &order.reference);
    match config.public_url.as_ref().and_then(qr_image_url) {
        Some(photo) => SendPhoto::new(chat_id, photo, caption)
            .with_keyboard(keyboard)
            .into(),
        // Without a public origin Telegram cannot fetch the QR, so the account
        // details go out on their own rather than as a broken photo.
        None => SendMessage::new(chat_id, caption)
            .with_keyboard(keyboard)
            .into(),
    }
}

pub fn usdt_transfer(
    chat_id: i64,
    language: Language,
    config: &AppConfig,
    order: &Order,
) -> SendMessage {
    let Some(wallet) = config.payment.usdt.as_ref() else {
        return unconfigured_method(
            chat_id,
            language,
            order,
            Localized {
                english: "⚠️ USDT payment is not configured yet.",
                vietnamese: "⚠️ Thanh toán USDT chưa được cấu hình.",
            },
        );
    };

    let amount = usdt_amount(order.total_vnd, wallet.vnd_rate);
    let transfer_memo = memo(&config.payment.memo_prefix, &order.reference);
    let expiry = format_expiry(order.expires_at);
    let text = match language {
        Language::English => format!(
            "₮ USDT payment\n\n🌐 Network: {network}\n🏷️ Address: {address}\n💰 Amount: {amount} USDT\n📝 Memo: {transfer_memo}\n⏳ Expires: {expiry}\n\n⚠️ A USDT transfer is reconciled by hand — send the transaction hash to {SUPPORT_HANDLE} after paying.",
            address = wallet.address,
            network = wallet.network,
        ),
        Language::Vietnamese => format!(
            "₮ Thanh toán USDT\n\n🌐 Mạng: {network}\n🏷️ Địa chỉ: {address}\n💰 Số tiền: {amount} USDT\n📝 Ghi chú: {transfer_memo}\n⏳ Hết hạn: {expiry}\n\n⚠️ USDT được đối soát thủ công — gửi mã giao dịch cho {SUPPORT_HANDLE} sau khi chuyển.",
            address = wallet.address,
            network = wallet.network,
        ),
    };

    SendMessage::new(chat_id, text).with_keyboard(watch_keyboard(language, &order.reference))
}

/// Reports the order as the API currently holds it, so a settled transfer shows
/// as settled and an unsettled one is not dressed up as anything else.
pub fn order_status(chat_id: i64, language: Language, order: &Order) -> SendMessage {
    let expiry = format_expiry(order.expires_at);
    let reference = &order.reference;
    let title = &order.item_title;
    let quantity = order.quantity;
    let total = format_amount(order.total_vnd);

    let (text, keyboard) = match order.status() {
        OrderStatus::Paid => (
            match language {
                Language::English => format!(
                    "✅ Payment received for order {reference}.\n\n{title}\nQuantity: {quantity}\nTotal: {total}₫\n\n{SUPPORT_HANDLE} will hand the account over shortly."
                ),
                Language::Vietnamese => format!(
                    "✅ Đã nhận thanh toán cho đơn {reference}.\n\n{title}\nSố lượng: {quantity}\nTổng: {total}₫\n\n{SUPPORT_HANDLE} sẽ bàn giao tài khoản ngay."
                ),
            },
            back_keyboard(language),
        ),
        OrderStatus::Cancelled => (
            match language {
                Language::English => format!(
                    "✖️ Order {reference} was stopped.\n\nUse /menu to pick another package."
                ),
                Language::Vietnamese => {
                    format!("✖️ Đơn {reference} đã dừng.\n\nDùng /menu để chọn gói khác.")
                }
            },
            back_keyboard(language),
        ),
        OrderStatus::AwaitingPayment | OrderStatus::Unknown if order.has_expired() => (
            match language {
                Language::English => format!(
                    "⌛ Order {reference} expired at {expiry} without a transfer.\n\nIf you have already paid, it is still matched when the transfer arrives with the right note; otherwise use /menu to start a new one."
                ),
                Language::Vietnamese => format!(
                    "⌛ Đơn {reference} đã hết hạn lúc {expiry} mà chưa có giao dịch.\n\nNếu bạn đã chuyển khoản, đơn vẫn được khớp khi giao dịch về đúng nội dung; nếu chưa thì dùng /menu để tạo đơn mới."
                ),
            },
            back_keyboard(language),
        ),
        OrderStatus::AwaitingPayment | OrderStatus::Unknown => (
            match language {
                Language::English => format!(
                    "⏳ No transfer has arrived for order {reference} yet.\n\nA bank transfer usually shows up within a minute. If you have already paid, wait a moment and check again.\n\n⏳ Expires: {expiry}"
                ),
                Language::Vietnamese => format!(
                    "⏳ Chưa nhận được giao dịch nào cho đơn {reference}.\n\nChuyển khoản thường về trong vòng một phút. Nếu bạn đã chuyển, chờ chút rồi kiểm tra lại.\n\n⏳ Hết hạn: {expiry}"
                ),
            },
            watch_keyboard(language, reference),
        ),
    };

    SendMessage::new(chat_id, text).with_keyboard(keyboard)
}

/// Sent unprompted when SePay reports a matching transfer, so the buyer is not
/// left pressing the check button.
pub fn payment_received(chat_id: i64, language: Language, order: &Order) -> SendMessage {
    order_status(chat_id, language, order)
}

pub fn payment_cancelled(chat_id: i64, language: Language, reference: &str) -> SendMessage {
    let text = match language {
        Language::English => format!(
            "✖️ Payment for order {reference} was stopped.\n\nUse /menu to pick another package."
        ),
        Language::Vietnamese => {
            format!("✖️ Đã dừng thanh toán cho đơn {reference}.\n\nDùng /menu để chọn gói khác.")
        }
    };

    SendMessage::new(chat_id, text).with_keyboard(back_keyboard(language))
}

pub fn orders(chat_id: i64, language: Language, orders: &[Order]) -> SendMessage {
    if orders.is_empty() {
        return SendMessage::new(
            chat_id,
            language.pick(Localized {
                english: "🧾 Orders\n\nYou have no orders yet. Use /menu to buy a package.",
                vietnamese: "🧾 Đơn hàng\n\nBạn chưa có đơn nào. Dùng /menu để mua một gói.",
            }),
        )
        .with_keyboard(back_keyboard(language));
    }

    let rows = orders
        .iter()
        .map(|order| {
            format!(
                "{} {} — {} × {} — {}₫",
                status_icon(order),
                order.reference,
                order.item_title,
                order.quantity,
                format_amount(order.total_vnd),
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let heading = language.pick(Localized {
        english: "🧾 Your latest orders",
        vietnamese: "🧾 Đơn hàng gần nhất của bạn",
    });

    SendMessage::new(chat_id, format!("{heading}\n\n{rows}")).with_keyboard(back_keyboard(language))
}

fn status_icon(order: &Order) -> &'static str {
    match order.status() {
        OrderStatus::Paid => "✅",
        OrderStatus::Cancelled => "✖️",
        _ if order.has_expired() => "⌛",
        _ => "⏳",
    }
}

/// Short enough for a Telegram callback popup, which is where a result that
/// does not deserve its own chat message is delivered.
pub fn pending_alert(language: Language, order: &Order) -> String {
    let reference = &order.reference;
    match language {
        Language::English => format!(
            "⏳ No transfer has arrived for order {reference} yet. A bank transfer usually lands within a minute — wait a moment and check again."
        ),
        Language::Vietnamese => format!(
            "⏳ Chưa nhận được giao dịch cho đơn {reference}. Chuyển khoản thường về trong vòng 1 phút — chờ chút rồi bấm kiểm tra lại."
        ),
    }
}

pub fn unknown_order_alert(language: Language) -> &'static str {
    language.pick(Localized {
        english: "⌛ This order has expired or is no longer active. Use /menu to start a new one.",
        vietnamese: "⌛ Đơn này đã hết hạn hoặc không còn hiệu lực. Dùng /menu để tạo đơn mới.",
    })
}

pub fn unknown_order(chat_id: i64, language: Language) -> SendMessage {
    SendMessage::new(
        chat_id,
        language.pick(Localized {
            english: "⌛ This order has expired or is no longer active.\n\nUse /menu to start a new one.",
            vietnamese: "⌛ Đơn này đã hết hạn hoặc không còn hiệu lực.\n\nDùng /menu để tạo đơn mới.",
        }),
    )
    .with_keyboard(back_keyboard(language))
}

pub fn start(chat_id: i64, language: Language) -> SendMessage {
    SendMessage::new(
        chat_id,
        language.pick(Localized {
            english: "Welcome to Hub William. Use /menu to view the shop, /orders to view your orders, or /help for support.",
            vietnamese: "Chào bạn đến với Hub William. Dùng /menu để xem shop, /orders để xem đơn hàng, hoặc /help để được hỗ trợ.",
        }),
    )
}

pub fn help(chat_id: i64, language: Language) -> SendMessage {
    SendMessage::new(
        chat_id,
        language.pick(Localized {
            english: "Hub William\n\n/menu — Shop\n/orders — Your orders\n/lang — Change language\n/help — Support\n\nSupport: @synasapmob",
            vietnamese: "Hub William\n\n/menu — Shop\n/orders — Đơn hàng của bạn\n/lang — Đổi ngôn ngữ\n/help — Hỗ trợ\n\nHỗ trợ: @synasapmob",
        }),
    )
}

pub fn status(chat_id: i64, language: Language) -> SendMessage {
    SendMessage::new(
        chat_id,
        language.pick(Localized {
            english: "Telegram is connected. Use /menu to browse the shop.",
            vietnamese: "Telegram đã được kết nối. Dùng /menu để xem shop.",
        }),
    )
}

fn menu_text(language: Language) -> &'static str {
    language.pick(Localized {
        english: "Hub William shop\n\nPick a provider.",
        vietnamese: "Hub William shop\n\nChọn nhà cung cấp.",
    })
}

/// The warranty legend sits on the package list rather than the provider list,
/// because that is the only screen where the codes appear.
fn provider_text(language: Language, provider: Provider) -> String {
    let heading = provider.name.to_owned();
    let guidance = language.pick(Localized {
        english: "Pick a package to see its details.\nWF = full warranty · W7D = 7-day warranty · NW = no warranty",
        vietnamese: "Chọn một gói để xem chi tiết.\nWF = bảo hành đầy đủ · W7D = bảo hành 7 ngày · NW = không bảo hành",
    });

    if items_for(provider).next().is_none() {
        let empty = language.pick(Localized {
            english: "No package is listed for this provider yet.",
            vietnamese: "Nhà cung cấp này chưa có gói nào.",
        });
        return format!("{heading}\n\n{empty}");
    }

    format!("{heading}\n\n{guidance}")
}

fn quantity_prompt_text(language: Language, item: CatalogItem) -> String {
    let available = item.available;
    let price = format_amount(item.base_price());
    let title = item.title();
    let tiers = item
        .tiers
        .iter()
        .map(|tier| {
            format!(
                "• {}+: {}₫",
                tier.minimum_quantity,
                format_amount(tier.price)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    match language {
        Language::English => format!(
            "🛒 {title}\n\n🔢 Enter the quantity you want\n\nMaximum: {available}\nSend a number, for example: 1\n\n💵 Current price: {price}₫\n\n💰 Price list:\n{tiers}\n\n{note}",
            note = item.warranty_note.english,
        ),
        Language::Vietnamese => format!(
            "🛒 {title}\n\n🔢 Nhập số lượng muốn mua\n\nTối đa: {available}\nGửi một số, ví dụ: 1\n\n💵 Giá hiện tại: {price}₫\n\n💰 Bảng giá:\n{tiers}\n\n{note}",
            note = item.warranty_note.vietnamese,
        ),
    }
}

fn unconfigured_method(
    chat_id: i64,
    language: Language,
    order: &Order,
    reason: Localized,
) -> SendMessage {
    let reference = &order.reference;
    let text = match language {
        Language::English => format!(
            "{}\n\nContact {SUPPORT_HANDLE} to pay for order {reference}.",
            reason.english
        ),
        Language::Vietnamese => format!(
            "{}\n\nLiên hệ {SUPPORT_HANDLE} để thanh toán đơn {reference}.",
            reason.vietnamese
        ),
    };

    SendMessage::new(chat_id, text).with_keyboard(back_keyboard(language))
}

fn language_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup {
        inline_keyboard: vec![vec![
            InlineKeyboardButton::callback("🇬🇧 English", "language:en"),
            InlineKeyboardButton::callback("🇻🇳 Tiếng Việt", "language:vi"),
        ]],
    }
}

/// The providers are the whole menu: language stays on /lang so the shop list
/// carries nothing but the shop.
fn menu_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup {
        inline_keyboard: PROVIDERS
            .into_iter()
            .map(|provider| {
                vec![InlineKeyboardButton::callback(
                    provider.name,
                    format!("provider:{}", provider.id),
                )]
            })
            .collect(),
    }
}

fn provider_keyboard(language: Language, provider: Provider) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup {
        inline_keyboard: items_for(provider)
            .map(|item| vec![catalogue_button(language, item)])
            .chain(std::iter::once(vec![back_to_menu_button(language)]))
            .collect(),
    }
}

fn catalogue_button(language: Language, item: CatalogItem) -> InlineKeyboardButton {
    let text = format!(
        "{} ({}) --- {}đ ({})",
        item.title(),
        item.warranty.code(),
        format_amount(item.base_price()),
        stock_label(language, item.available),
    );

    if item.is_available() {
        InlineKeyboardButton::success_callback(text, format!("catalog:{}", item.id))
    } else {
        InlineKeyboardButton::disabled_danger(text)
    }
}

fn back_to_menu_button(language: Language) -> InlineKeyboardButton {
    InlineKeyboardButton::callback(
        language.pick(Localized {
            english: "‹ Back to shop",
            vietnamese: "‹ Quay lại shop",
        }),
        "menu",
    )
}

fn back_keyboard(language: Language) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup {
        inline_keyboard: vec![vec![back_to_menu_button(language)]],
    }
}

fn back_to_provider_keyboard(language: Language, provider: Provider) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup {
        inline_keyboard: vec![vec![InlineKeyboardButton::callback(
            match language {
                Language::English => format!("‹ Back to {}", provider.name),
                Language::Vietnamese => format!("‹ Quay lại {}", provider.name),
            },
            format!("provider:{}", provider.id),
        )]],
    }
}

fn watch_keyboard(language: Language, reference: &str) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup {
        inline_keyboard: vec![vec![
            InlineKeyboardButton::callback(
                language.pick(Localized {
                    english: "🔄 Check payment",
                    vietnamese: "🔄 Kiểm tra thanh toán",
                }),
                format!("pay:check:{reference}"),
            ),
            InlineKeyboardButton::callback(
                language.pick(Localized {
                    english: "✖️ Stop payment",
                    vietnamese: "✖️ Dừng thanh toán",
                }),
                format!("pay:cancel:{reference}"),
            ),
        ]],
    }
}

fn stock_label(language: Language, available: u32) -> String {
    match (language, available) {
        (Language::English, 0) => "sold out".to_owned(),
        (Language::Vietnamese, 0) => "hết hàng".to_owned(),
        (Language::English, amount) => format!("{amount} left"),
        (Language::Vietnamese, amount) => format!("còn {amount}"),
    }
}
