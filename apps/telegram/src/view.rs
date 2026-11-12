use crate::{
    catalog::{Catalogue, Product, Provider, format_amount},
    checkout::{Delivery, Order, OrderStatus, format_expiry, memo, qr_image_url, usdt_amount},
    config::AppConfig,
    language::{Language, Localized},
    telegram::{
        EditMessageText, InlineKeyboardButton, InlineKeyboardMarkup, Reply, SendMessage, SendPhoto,
    },
};

const LANGUAGE_PROMPT: &str = "Choose a language / Chọn ngôn ngữ";

pub fn language_picker(chat_id: i64) -> SendMessage {
    SendMessage::new(chat_id, LANGUAGE_PROMPT).with_keyboard(language_keyboard())
}

pub fn menu(chat_id: i64, language: Language, catalogue: &Catalogue) -> SendMessage {
    SendMessage::new(chat_id, menu_text(language, catalogue))
        .with_keyboard(menu_keyboard(catalogue))
}

/// Every shop screen is text, so a button rewrites the message it belongs to
/// rather than replacing it — nothing moves to the end of the chat.
/// What a refresh button's data starts with; the rest says which screen to draw.
pub const REFRESH_PREFIX: &str = "refresh:";

/// The most Telegram allows in the data of one button.
const MAXIMUM_CALLBACK_DATA_BYTES: usize = 64;

pub fn edit_menu(
    chat_id: i64,
    message_id: i64,
    language: Language,
    catalogue: &Catalogue,
) -> EditMessageText {
    EditMessageText::new(chat_id, message_id, menu_text(language, catalogue))
        .with_keyboard(menu_keyboard(catalogue))
}

pub fn edit_provider(
    chat_id: i64,
    message_id: i64,
    language: Language,
    provider: &Provider,
) -> EditMessageText {
    EditMessageText::new(chat_id, message_id, provider_text(language, provider))
        .with_keyboard(provider_keyboard(language, provider))
}

pub fn edit_quantity_prompt(
    chat_id: i64,
    message_id: i64,
    language: Language,
    product: &Product,
) -> EditMessageText {
    EditMessageText::new(chat_id, message_id, quantity_prompt_text(language, product))
        .with_keyboard(back_to_provider_keyboard(language, product))
}

pub fn quantity_prompt(chat_id: i64, language: Language, product: &Product) -> SendMessage {
    SendMessage::new(chat_id, quantity_prompt_text(language, product))
        .with_keyboard(back_to_provider_keyboard(language, product))
}

pub fn quantity_error(chat_id: i64, language: Language, product: &Product) -> SendMessage {
    let available = product.order_limit();
    if !product.is_available() {
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

/// The QR is made for this order, with the account, amount and transfer note
/// already in it. The note is what SePay matches the order on, so the caption
/// still spells it out for a buyer who types the transfer by hand.
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
            &config.owner.handle(),
        )
        .into();
    };

    let transfer_memo = memo(&config.payment.memo_prefix, &order.reference);
    let total = format_amount(order.total_vnd);
    let expiry = format_expiry(order.expires_at);
    let caption = match language {
        Language::English => format!(
            "🏦 Bank transfer\n\n🏛️ Bank: {name}\n👤 Account name: {holder}\n💳 Account number: {number}\n💰 Amount: {total}₫\n📝 Transfer note: {transfer_memo}\n⚠️ A transfer sent with the wrong note needs manual handling and is charged $2 per transaction.\n⏳ Expires: {expiry}. Pay before then: after it this order is void and a later transfer will not settle it.\n\n👆 Scan the QR above: the amount and the transfer note are already filled in.\n✅ The order is processed automatically once the payment arrives.",
            holder = bank.holder,
            name = bank.name,
            number = bank.number,
        ),
        Language::Vietnamese => format!(
            "🏦 Thanh toán chuyển khoản\n\n🏛️ Ngân hàng: {name}\n👤 Chủ TK: {holder}\n💳 Số TK: {number}\n💰 Số tiền: {total}₫\n📝 Nội dung CK: {transfer_memo}\n⚠️ Giao dịch chuyển sai cú pháp sẽ cần xử lý thủ công và bị tính phí $2/giao dịch.\n⏳ Hết hạn: {expiry}. Hãy chuyển khoản trước giờ này: sau đó đơn không còn hiệu lực và giao dịch chuyển trễ sẽ không được khớp.\n\n👆 Quét mã QR phía trên: số tiền và nội dung CK đã được điền sẵn.\n✅ Đơn hàng xử lý tự động sau khi thanh toán.",
            holder = bank.holder,
            name = bank.name,
            number = bank.number,
        ),
    };

    SendPhoto::new(
        chat_id,
        qr_image_url(bank, order.total_vnd, &transfer_memo),
        caption,
    )
    .with_keyboard(watch_keyboard(language, &order.reference))
    .into()
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
            &config.owner.handle(),
        );
    };

    let amount = usdt_amount(order.total_vnd, wallet.vnd_rate);
    let transfer_memo = memo(&config.payment.memo_prefix, &order.reference);
    let expiry = format_expiry(order.expires_at);
    let support = config.owner.handle();
    let text = match language {
        Language::English => format!(
            "₮ USDT payment\n\n🌐 Network: {network}\n🏷️ Address: {address}\n💰 Amount: {amount} USDT\n📝 Memo: {transfer_memo}\n⏳ Expires: {expiry}\n\n⚠️ A USDT transfer is reconciled by hand — send the transaction hash to {support} after paying.",
            address = wallet.address,
            network = wallet.network,
        ),
        Language::Vietnamese => format!(
            "₮ Thanh toán USDT\n\n🌐 Mạng: {network}\n🏷️ Địa chỉ: {address}\n💰 Số tiền: {amount} USDT\n📝 Ghi chú: {transfer_memo}\n⏳ Hết hạn: {expiry}\n\n⚠️ USDT được đối soát thủ công — gửi mã giao dịch cho {support} sau khi chuyển.",
            address = wallet.address,
            network = wallet.network,
        ),
    };

    SendMessage::new(chat_id, text).with_keyboard(watch_keyboard(language, &order.reference))
}

/// What a paid order says. Without a delivery, or for a package that hands out
/// nothing, the buyer is told to write to the owner with the order's reference,
/// and the owner hands the account over: the owner is not told of the payment,
/// so it is the buyer's message that starts it. With a delivery, the accounts are
/// in the message, and an order that got fewer than it asked for says how many it
/// is missing and who to write to, with the order's reference, because it is the
/// owner and the buyer who settle that between them.
/// The receipt, with the shop's guide to using the package after it when there is one.
fn paid_text(
    language: Language,
    order: &Order,
    support: &str,
    delivery: Option<&Delivery>,
    guide: Option<&str>,
) -> String {
    let receipt = paid_receipt(language, order, support, delivery);

    match (guide, language) {
        (Some(guide), Language::English) => format!("{receipt}\n\n📖 How to use:\n{guide}"),
        (Some(guide), Language::Vietnamese) => {
            format!("{receipt}\n\n📖 Hướng dẫn sử dụng:\n{guide}")
        }
        (None, _) => receipt,
    }
}

fn paid_receipt(
    language: Language,
    order: &Order,
    support: &str,
    delivery: Option<&Delivery>,
) -> String {
    let reference = &order.reference;
    let title = &order.item_title;
    let quantity = order.quantity;
    let total = format_amount(order.total_vnd);
    let head = match language {
        Language::English => format!(
            "✅ Payment received for order {reference}.\n\n{title}\nQuantity: {quantity}\nTotal: {total}₫"
        ),
        Language::Vietnamese => format!(
            "✅ Đã nhận thanh toán cho đơn {reference}.\n\n{title}\nSố lượng: {quantity}\nTổng: {total}₫"
        ),
    };

    let Some(delivery) = delivery.filter(|d| !d.accounts.is_empty() || d.missing > 0) else {
        return match language {
            Language::English => format!(
                "{head}\n\n📩 To receive your account, write to {support} with order {reference} and they will hand it over."
            ),
            Language::Vietnamese => format!(
                "{head}\n\n📩 Để nhận tài khoản, nhắn {support} kèm mã đơn {reference}, chủ shop sẽ bàn giao cho bạn."
            ),
        };
    };

    let accounts = match delivery.accounts.as_slice() {
        [] => String::new(),
        [only] => only.clone(),
        many => many
            .iter()
            .enumerate()
            .map(|(index, account)| format!("{}. {account}", index + 1))
            .collect::<Vec<_>>()
            .join("\n"),
    };
    let missing = delivery.missing;

    match (language, accounts.is_empty()) {
        (Language::English, false) if missing == 0 => format!(
            "{head}\n\n🔑 Your account:\n{accounts}\n\nPlease change the password as soon as you have it."
        ),
        (Language::English, false) => format!(
            "{head}\n\n🔑 Your account:\n{accounts}\n\n⚠️ {missing} more could not be given because they ran out. Write to {support} with order {reference} and they will sort it out."
        ),
        (Language::English, true) => format!(
            "{head}\n\n⚠️ The accounts ran out, so none could be given. Write to {support} with order {reference} and they will sort it out."
        ),
        (Language::Vietnamese, false) if missing == 0 => format!(
            "{head}\n\n🔑 Tài khoản của bạn:\n{accounts}\n\nHãy đổi mật khẩu ngay sau khi nhận."
        ),
        (Language::Vietnamese, false) => format!(
            "{head}\n\n🔑 Tài khoản của bạn:\n{accounts}\n\n⚠️ Còn thiếu {missing} tài khoản vì đã hết hàng. Nhắn {support} kèm mã đơn {reference} để được xử lý."
        ),
        (Language::Vietnamese, true) => format!(
            "{head}\n\n⚠️ Tài khoản đã hết nên chưa giao được. Nhắn {support} kèm mã đơn {reference} để được xử lý."
        ),
    }
}

/// Reports the order as the API currently holds it, so a settled transfer shows
/// as settled and an unsettled one is not dressed up as anything else.
pub fn order_status(
    chat_id: i64,
    language: Language,
    order: &Order,
    support: &str,
    delivery: Option<&Delivery>,
    guide: Option<&str>,
) -> SendMessage {
    let expiry = format_expiry(order.expires_at);
    let reference = &order.reference;

    let (text, keyboard) = match order.status() {
        OrderStatus::Paid => (
            paid_text(language, order, support, delivery, guide),
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
                    "⌛ Order {reference} expired at {expiry} without a transfer.\n\nThis order is no longer valid, so please do not transfer for it. Use /menu to start a new one."
                ),
                Language::Vietnamese => format!(
                    "⌛ Đơn {reference} đã hết hạn lúc {expiry} mà chưa có giao dịch.\n\nĐơn này không còn hiệu lực, vui lòng không chuyển khoản cho đơn này. Dùng /menu để tạo đơn mới."
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
pub fn payment_received(
    chat_id: i64,
    language: Language,
    order: &Order,
    support: &str,
    delivery: Option<&Delivery>,
    guide: Option<&str>,
) -> SendMessage {
    order_status(chat_id, language, order, support, delivery, guide)
}

/// Sent unprompted when money arrives for an order that had already run out. The
/// order is not paid and nothing is handed out, so the buyer is told to write to
/// the owner with the order's reference, who gives them the goods or the money
/// back. It does not say which: that is the owner's to decide.
pub fn late_payment(
    chat_id: i64,
    language: Language,
    order: &Order,
    amount_vnd: i64,
    support: &str,
) -> SendMessage {
    let reference = &order.reference;
    let title = &order.item_title;
    let quantity = order.quantity;
    let amount = format_amount(amount_vnd);

    let text = match language {
        Language::English => format!(
            "⚠️ We received {amount}₫ from you, but order {reference} had already expired, so it was not completed.\n\n{title}\nQuantity: {quantity}\n\n📩 Write to {support} with order {reference} and they will give you the goods or your money back."
        ),
        Language::Vietnamese => format!(
            "⚠️ Đã nhận {amount}₫ từ bạn, nhưng đơn {reference} đã hết hạn nên chưa hoàn tất.\n\n{title}\nSố lượng: {quantity}\n\n📩 Nhắn {support} kèm mã đơn {reference}, chủ shop sẽ giao hàng hoặc hoàn tiền cho bạn."
        ),
    };

    SendMessage::new(chat_id, text).with_keyboard(back_keyboard(language))
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

fn menu_text(language: Language, catalogue: &Catalogue) -> &'static str {
    if catalogue.providers.is_empty() {
        return language.pick(Localized {
            english: "Hub William shop\n\nNothing is listed right now. Try again shortly.",
            vietnamese: "Hub William shop\n\nHiện chưa có gói nào. Bạn quay lại sau nhé.",
        });
    }

    language.pick(Localized {
        english: "Hub William shop\n\nPick a provider.",
        vietnamese: "Hub William shop\n\nChọn nhà cung cấp.",
    })
}

/// The warranty legend sits on the package list rather than the provider list,
/// because that is the only screen where the codes appear.
fn provider_text(language: Language, provider: &Provider) -> String {
    let heading = &provider.name;
    let guidance = language.pick(Localized {
        english: "Pick a package to see its details.\nWF = full warranty\nW7D = 7-day warranty\nNW = no warranty",
        vietnamese: "Chọn một gói để xem chi tiết.\nWF = bảo hành đầy đủ\nW7D = bảo hành 7 ngày\nNW = không bảo hành",
    });

    if provider.products.is_empty() {
        let empty = language.pick(Localized {
            english: "No package is listed for this provider yet.",
            vietnamese: "Nhà cung cấp này chưa có gói nào.",
        });
        return format!("{heading}\n\n{empty}");
    }

    format!("{heading}\n\n{guidance}")
}

fn quantity_prompt_text(language: Language, product: &Product) -> String {
    let available = product.order_limit();
    let price = format_amount(product.price_vnd);
    let title = product.headline();
    let tiers = format!("• 1+: {price}₫");
    // The shop's note for the package, after a blank line; a package without one
    // ends at its price list.
    let note = match product.note(language) {
        "" => String::new(),
        note => format!("\n\n{note}"),
    };

    match language {
        Language::English => format!(
            "{title}\n\n🔢 Enter the quantity you want\n\nMaximum: {available}\nSend a number, for example: 1\n\n💵 Current price: {price}₫\n\n💰 Price list:\n{tiers}{note}",
        ),
        Language::Vietnamese => format!(
            "{title}\n\n🔢 Nhập số lượng muốn mua\n\nTối đa: {available}\nGửi một số, ví dụ: 1\n\n💵 Giá hiện tại: {price}₫\n\n💰 Bảng giá:\n{tiers}{note}",
        ),
    }
}

fn unconfigured_method(
    chat_id: i64,
    language: Language,
    order: &Order,
    reason: Localized,
    support: &str,
) -> SendMessage {
    let reference = &order.reference;
    let text = match language {
        Language::English => format!(
            "{}\n\nContact {support} to pay for order {reference}.",
            reason.english
        ),
        Language::Vietnamese => format!(
            "{}\n\nLiên hệ {support} để thanh toán đơn {reference}.",
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
fn menu_keyboard(catalogue: &Catalogue) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup {
        inline_keyboard: catalogue
            .providers
            .iter()
            .map(|provider| {
                vec![InlineKeyboardButton::callback(
                    provider.name.clone(),
                    format!("provider:{}", provider.slug),
                )]
            })
            .collect(),
    }
}

fn provider_keyboard(language: Language, provider: &Provider) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup {
        inline_keyboard: provider
            .products
            .iter()
            .map(|product| vec![catalogue_button(language, product)])
            .chain(std::iter::once(vec![back_to_menu_button(language)]))
            .chain(
                refresh_button(language, &format!("provider:{}", provider.slug))
                    .map(|button| vec![button]),
            )
            .collect(),
    }
}

fn catalogue_button(language: Language, product: &Product) -> InlineKeyboardButton {
    let text = format!(
        "{} · ({}) · {}đ ({})",
        product.headline(),
        product.warranty,
        format_amount(product.price_vnd),
        stock_label(language, product.available),
    );

    if product.is_available() {
        InlineKeyboardButton::success_callback(text, format!("catalog:{}", product.slug))
    } else {
        InlineKeyboardButton::disabled_danger(text)
    }
}

fn back_to_menu_button(language: Language) -> InlineKeyboardButton {
    InlineKeyboardButton::callback(back_label(language), "menu")
}

/// Every screen says "back" the same way, whichever screen it goes back to.
fn back_label(language: Language) -> &'static str {
    language.pick(Localized {
        english: "‹ Back",
        vietnamese: "‹ Quay trở lại",
    })
}

/// A button that draws the screen it sits on again from the API, so a count or a
/// price that changed since the screen was opened shows up. `screen` is what
/// opens that screen (`provider:claude`, `catalog:claude-pro`). Telegram refuses
/// button data over 64 bytes, and one bad button would break the whole screen,
/// so a screen whose address is too long goes without the button.
fn refresh_button(language: Language, screen: &str) -> Option<InlineKeyboardButton> {
    let data = format!("{REFRESH_PREFIX}{screen}");

    (data.len() <= MAXIMUM_CALLBACK_DATA_BYTES).then(|| {
        InlineKeyboardButton::callback(
            language.pick(Localized {
                english: "🔄 Refresh",
                vietnamese: "🔄 Tải lại",
            }),
            data,
        )
    })
}

/// What a buyer sees for a moment after tapping the refresh button.
pub fn refreshed_notice(language: Language) -> &'static str {
    language.pick(Localized {
        english: "✅ Refreshed",
        vietnamese: "✅ Đã tải lại",
    })
}

fn back_keyboard(language: Language) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup {
        inline_keyboard: vec![vec![back_to_menu_button(language)]],
    }
}

/// The quantity prompt: back to the package list, and below it a refresh of the
/// prompt itself.
fn back_to_provider_keyboard(language: Language, product: &Product) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup {
        inline_keyboard: std::iter::once(vec![InlineKeyboardButton::callback(
            back_label(language),
            format!("provider:{}", product.provider_slug),
        )])
        .chain(
            refresh_button(language, &format!("catalog:{}", product.slug))
                .map(|button| vec![button]),
        )
        .collect(),
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

fn stock_label(language: Language, available: i64) -> String {
    match (language, available) {
        (Language::English, 0) => "sold out".to_owned(),
        (Language::Vietnamese, 0) => "hết hàng".to_owned(),
        (Language::English, amount) => format!("{amount} left"),
        (Language::Vietnamese, amount) => format!("còn {amount}"),
    }
}

/// The owner side of `/catalog`. It lists everything, including hidden
/// products, so a mistake is visible and reversible.
pub fn admin_catalogue(chat_id: i64, catalogue: &Catalogue) -> SendMessage {
    SendMessage::new(chat_id, admin_catalogue_text(catalogue))
        .with_keyboard(admin_catalogue_keyboard(catalogue))
}

pub fn edit_admin_catalogue(
    chat_id: i64,
    message_id: i64,
    catalogue: &Catalogue,
) -> EditMessageText {
    EditMessageText::new(chat_id, message_id, admin_catalogue_text(catalogue))
        .with_keyboard(admin_catalogue_keyboard(catalogue))
}

pub fn edit_admin_product(chat_id: i64, message_id: i64, product: &Product) -> EditMessageText {
    EditMessageText::new(chat_id, message_id, admin_product_text(product))
        .with_keyboard(admin_product_keyboard(product))
}

pub fn admin_product(chat_id: i64, product: &Product) -> SendMessage {
    SendMessage::new(chat_id, admin_product_text(product))
        .with_keyboard(admin_product_keyboard(product))
}

pub fn admin_restock_prompt(chat_id: i64, message_id: i64, product: &Product) -> EditMessageText {
    EditMessageText::new(
        chat_id,
        message_id,
        format!(
            "➕ Thêm hàng — {title}\n\n📦 Tồn kho hiện tại: {on_hand}\n\nGửi số lượng muốn thêm, ví dụ: 7",
            on_hand = product.on_hand,
            title = product.title(),
        ),
    )
    .with_keyboard(admin_back_keyboard(&product.slug))
}

pub fn admin_price_prompt(chat_id: i64, message_id: i64, product: &Product) -> EditMessageText {
    EditMessageText::new(
        chat_id,
        message_id,
        format!(
            "💰 Đổi giá — {title}\n\n💵 Giá hiện tại: {price}₫\n\nGửi giá mới bằng đồng, ví dụ: 135000",
            price = format_amount(product.price_vnd),
            title = product.title(),
        ),
    )
    .with_keyboard(admin_back_keyboard(&product.slug))
}

/// A product needs more fields than one command line carries comfortably, so
/// the owner fills in a template and sends it back.
pub fn admin_new_product_prompt(chat_id: i64, message_id: i64) -> EditMessageText {
    EditMessageText::new(
        chat_id,
        message_id,
        "🆕 Gói mới\n\nGửi lại khối dưới đây, điền giá trị của bạn:\n\nnhà cung cấp: Capcut\ntên: Pro 30D\nbiến thể: Personal\nchi tiết: 1M\ndanh mục: AI Tools\nbảo hành: W7D\ngiá: 50000\ntồn: 7\n\n• bảo hành: WF, W7D hoặc NW\n• biến thể, chi tiết và danh mục bỏ trống được\n• nhà cung cấp chưa có sẽ được tạo mới",
    )
    .with_keyboard(InlineKeyboardMarkup {
        inline_keyboard: vec![vec![InlineKeyboardButton::callback(
            "‹ Quay trở lại",
            "admin",
        )]],
    })
}

pub fn admin_result(chat_id: i64, message: impl Into<String>) -> SendMessage {
    SendMessage::new(chat_id, message).with_keyboard(InlineKeyboardMarkup {
        inline_keyboard: vec![vec![InlineKeyboardButton::callback(
            "‹ Quản lý kho",
            "admin",
        )]],
    })
}

/// The message a buyer gets when stock lands. It leads with the provider so a
/// glance is enough, and the button is a deep link straight to the product.
pub fn restock_announcement(
    chat_id: i64,
    added: i64,
    product: &Product,
    bot_username: Option<&str>,
) -> SendMessage {
    SendMessage::new(chat_id, restock_text(added, product))
        .with_keyboard(buy_now_keyboard(&product.slug, bot_username))
}

/// The same announcement addressed to a channel, which Telegram takes by
/// `@name` as readily as by id.
pub fn restock_channel_post(
    chat_id: String,
    added: i64,
    product: &Product,
    bot_username: Option<&str>,
) -> SendMessage {
    SendMessage::to_chat(chat_id, restock_text(added, product))
        .with_keyboard(buy_now_keyboard(&product.slug, bot_username))
}

fn restock_text(added: i64, product: &Product) -> String {
    let category = product
        .category
        .as_deref()
        .map(|category| format!("📁 Danh mục: {category}\n"))
        .unwrap_or_default();

    format!(
        "🔥 {provider} có hàng mới\n🛍️ {title} ({warranty})\n{category}💰 Giá: {price}₫\n📦 Tồn kho: {available} · vừa nhập {added}\n\n👇 Bấm nút bên dưới để mua ngay:",
        available = product.available,
        price = format_amount(product.price_vnd),
        provider = product.provider_name,
        title = product.title(),
        warranty = product.warranty,
    )
}

/// A message of the shop's own words. Naming a product gives it the same
/// "Mua ngay" button a restock carries, so the button needs no text of its own.
pub fn announcement(
    chat_id: i64,
    text: &str,
    product: Option<&str>,
    bot_username: Option<&str>,
) -> SendMessage {
    with_buy_now(SendMessage::new(chat_id, text), product, bot_username)
}

/// The same message addressed to a channel.
pub fn announcement_channel_post(
    chat_id: String,
    text: &str,
    product: Option<&str>,
    bot_username: Option<&str>,
) -> SendMessage {
    with_buy_now(SendMessage::to_chat(chat_id, text), product, bot_username)
}

fn with_buy_now(
    message: SendMessage,
    product: Option<&str>,
    bot_username: Option<&str>,
) -> SendMessage {
    match product {
        Some(slug) => message.with_keyboard(buy_now_keyboard(slug, bot_username)),
        None => message,
    }
}

/// Without a bot username there is no link to send anyone to, so the message
/// goes out on its own rather than with a dead button.
fn buy_now_keyboard(slug: &str, bot_username: Option<&str>) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup {
        inline_keyboard: match bot_username {
            Some(username) => vec![vec![InlineKeyboardButton::url(
                "🛒 Mua ngay",
                format!("https://t.me/{username}?start={slug}"),
            )]],
            None => Vec::new(),
        },
    }
}

fn admin_catalogue_text(catalogue: &Catalogue) -> String {
    if catalogue.providers.is_empty() {
        return "🛠 Quản lý kho\n\nChưa có gói nào. Bấm “Gói mới” để thêm.".to_owned();
    }

    let rows = catalogue
        .providers
        .iter()
        .map(|provider| {
            let products = provider
                .products
                .iter()
                .map(|product| {
                    format!(
                        "  {} {} — {}₫ — còn {}",
                        if product.listed { "•" } else { "🙈" },
                        product.headline(),
                        format_amount(product.price_vnd),
                        product.available,
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!("{}\n{products}", provider.name)
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    format!("🛠 Quản lý kho\n\n{rows}\n\nChọn một gói để sửa.")
}

fn admin_catalogue_keyboard(catalogue: &Catalogue) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup {
        inline_keyboard: catalogue
            .products()
            .map(|product| {
                vec![InlineKeyboardButton::callback(
                    format!("{} — còn {}", product.headline(), product.available),
                    format!("admin:open:{}", product.slug),
                )]
            })
            .chain(std::iter::once(vec![InlineKeyboardButton::callback(
                "🆕 Gói mới",
                "admin:new",
            )]))
            .collect(),
    }
}

fn admin_product_text(product: &Product) -> String {
    format!(
        "🛠 {title}\n\n📦 Tồn kho: {on_hand}{held}\n📁 Danh mục: {category}\n💰 Giá: {price}₫\n🔖 Bảo hành: {warranty}\n{hot}\n{listed}",
        category = product.category.as_deref().unwrap_or("—"),
        held = match product.reserved {
            0 => String::new(),
            reserved => format!(" · đang giữ {reserved} · bán được {}", product.available),
        },
        on_hand = product.on_hand,
        hot = if product.hot {
            "🔥 Đang gắn hot"
        } else {
            "▫️ Không gắn hot"
        },
        listed = if product.listed {
            "👁 Đang hiện trong shop"
        } else {
            "🙈 Đang ẩn khỏi shop"
        },
        price = format_amount(product.price_vnd),
        title = product.title(),
        warranty = product.warranty,
    )
}

fn admin_product_keyboard(product: &Product) -> InlineKeyboardMarkup {
    let slug = &product.slug;

    InlineKeyboardMarkup {
        inline_keyboard: vec![
            vec![
                InlineKeyboardButton::callback("➕ Thêm hàng", format!("admin:restock:{slug}")),
                InlineKeyboardButton::callback("💰 Đổi giá", format!("admin:price:{slug}")),
            ],
            vec![
                InlineKeyboardButton::callback(
                    if product.hot {
                        "▫️ Bỏ hot"
                    } else {
                        "🔥 Gắn hot"
                    },
                    format!("admin:hot:{slug}"),
                ),
                InlineKeyboardButton::callback(
                    if product.listed {
                        "🙈 Ẩn khỏi shop"
                    } else {
                        "👁 Hiện trong shop"
                    },
                    format!("admin:listed:{slug}"),
                ),
            ],
            vec![InlineKeyboardButton::callback("‹ Quản lý kho", "admin")],
        ],
    }
}

fn admin_back_keyboard(slug: &str) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup {
        inline_keyboard: vec![vec![InlineKeyboardButton::callback(
            "‹ Quay trở lại",
            format!("admin:open:{slug}"),
        )]],
    }
}

#[cfg(test)]
mod tests {
    use chrono::{TimeDelta, Utc};
    use serde_json::{Value, json};

    use super::{catalogue_button, order_status, quantity_prompt};
    use crate::{
        catalog::Product,
        checkout::{Delivery, Order},
        language::Language,
    };

    fn order(status: &str, expires_in_minutes: i64) -> Order {
        serde_json::from_value(json!({
            "chat_id": 123,
            "expires_at": Utc::now() + TimeDelta::minutes(expires_in_minutes),
            "item_title": "Claude MAX X20",
            "quantity": 1,
            "reference": "1GS0H75MMX9P",
            "status": status,
            "telegram_user_id": 456,
            "total_vnd": 135_000,
            "unit_price_vnd": 135_000
        }))
        .unwrap()
    }

    fn package(slug: &str) -> Product {
        serde_json::from_value(json!({
            "available": 5, "category": null, "detail": null, "hot": false, "listed": true,
            "on_hand": 5, "plan": "Pro", "price_vnd": 100_000, "provider_name": "Claude",
            "provider_slug": "claude", "reserved": 0, "slug": slug, "variant": null,
            "warranty": "WF", "warranty_note_en": "note", "warranty_note_vi": "ghi chú"
        }))
        .unwrap()
    }

    fn rows_of(product: &Product) -> usize {
        let message: Value =
            serde_json::to_value(quantity_prompt(123, Language::Vietnamese, product)).unwrap();
        message["reply_markup"]["inline_keyboard"]
            .as_array()
            .unwrap()
            .len()
    }

    #[test]
    fn a_screen_whose_refresh_data_would_be_too_long_goes_without_the_button() {
        // `refresh:catalog:` is 16 bytes, so 48 more is the most that fits in 64.
        assert_eq!(rows_of(&package(&"a".repeat(48))), 2, "back and refresh");
        assert_eq!(rows_of(&package(&"a".repeat(49))), 1, "back only");
    }

    fn text_of(language: Language, order: &Order) -> String {
        let message: Value = serde_json::to_value(order_status(
            123,
            language,
            order,
            "@shop_owner",
            None,
            None,
        ))
        .unwrap();
        message["text"].as_str().unwrap().to_owned()
    }

    #[test]
    fn a_package_note_reaches_the_buyer_with_its_line_breaks_and_blank_lines_as_written() {
        let note = "Bảo hành 30 ngày\n\n  - Đổi tài khoản khác\n- Không hoàn tiền   sau 7 ngày\n\nLiên hệ shop";
        let mut product = package("claude-pro");
        product.warranty_note_en = note.to_owned();
        product.warranty_note_vi = note.to_owned();

        for language in [Language::English, Language::Vietnamese] {
            let message: Value =
                serde_json::to_value(quantity_prompt(123, language, &product)).unwrap();
            let text = message["text"].as_str().unwrap();

            // At the end of the prompt, byte for byte.
            assert!(text.ends_with(&format!("\n\n{note}")), "{text}");
            // Plain text: Telegram is not asked to read it as markup, which would
            // eat the characters it takes for formatting.
            assert!(message.get("parse_mode").is_none(), "{message}");
        }
    }

    #[test]
    fn a_package_without_a_note_ends_at_its_price_list_with_nothing_after_it() {
        let mut product = package("claude-pro");
        product.warranty_note_en = String::new();
        product.warranty_note_vi = String::new();

        for language in [Language::English, Language::Vietnamese] {
            let message: Value =
                serde_json::to_value(quantity_prompt(123, language, &product)).unwrap();
            let text = message["text"].as_str().unwrap();

            assert!(text.ends_with("• 1+: 100,000₫"), "{text:?}");
        }
    }

    #[test]
    fn a_package_row_reads_name_warranty_price_and_stock_apart_by_dots() {
        // The shop wrote the whole name, brand included; nothing is put in front of it.
        let mut product = package("gemini-ai-pro");
        product.provider_name = "Gemini".to_owned();
        product.plan = "Gemini AI PRO your mail".to_owned();
        product.warranty = "NW".to_owned();
        product.price_vnd = 70_000;
        product.available = 1;
        let text = |language| {
            let button: Value = serde_json::to_value(catalogue_button(language, &product)).unwrap();

            button["text"].as_str().unwrap().to_owned()
        };

        assert_eq!(
            text(Language::English),
            "Gemini AI PRO your mail · (NW) · 70,000đ (1 left)"
        );
        assert_eq!(
            text(Language::Vietnamese),
            "Gemini AI PRO your mail · (NW) · 70,000đ (còn 1)"
        );
    }

    #[test]
    fn a_paid_order_with_nothing_handed_out_sends_the_buyer_to_the_owner_with_its_reference() {
        let paid = order("paid", 0);

        let english = text_of(Language::English, &paid);
        assert!(
            english.ends_with(&format!(
                "write to @shop_owner with order {} and they will hand it over.",
                paid.reference
            )),
            "{english}"
        );

        let vietnamese = text_of(Language::Vietnamese, &paid);
        assert!(
            vietnamese.ends_with(&format!(
                "nhắn @shop_owner kèm mã đơn {}, chủ shop sẽ bàn giao cho bạn.",
                paid.reference
            )),
            "{vietnamese}"
        );
    }

    #[test]
    fn a_guide_the_shop_wrote_follows_the_receipt_in_either_language() {
        let paid = order("paid", 0);
        let guide = Some("Đăng nhập bằng email được gửi.\nKhông đổi mật khẩu.");
        let text = |language, guide| {
            let message =
                serde_json::to_value(order_status(1, language, &paid, "@shop_owner", None, guide))
                    .unwrap();

            message["text"].as_str().unwrap().to_owned()
        };

        let english = text(Language::English, guide);
        assert!(
            english
                .ends_with("📖 How to use:\nĐăng nhập bằng email được gửi.\nKhông đổi mật khẩu."),
            "{english}"
        );
        assert!(english.contains("and they will hand it over."), "{english}");

        let vietnamese = text(Language::Vietnamese, guide);
        assert!(
            vietnamese.ends_with(
                "📖 Hướng dẫn sử dụng:\nĐăng nhập bằng email được gửi.\nKhông đổi mật khẩu."
            ),
            "{vietnamese}"
        );

        // Nothing written, nothing added.
        assert!(!text(Language::English, None).contains("How to use"));
        assert!(!text(Language::Vietnamese, None).contains("Hướng dẫn"));
    }

    #[test]
    fn the_guide_is_the_last_thing_a_buyer_reads_after_the_accounts_they_are_handed() {
        let paid = order("paid", 0);
        let delivery = Delivery {
            accounts: vec!["one@example.test|first".to_owned()],
            missing: 0,
        };
        let message = serde_json::to_value(order_status(
            1,
            Language::Vietnamese,
            &paid,
            "@shop_owner",
            Some(&delivery),
            Some("Đăng nhập bằng email được gửi.\nKhông đổi mật khẩu."),
        ))
        .unwrap();
        let text = message["text"].as_str().unwrap();

        println!("{text}");
        let position = |part: &str| {
            text.find(part)
                .unwrap_or_else(|| panic!("{part} is missing"))
        };

        // Receipt, then the account, then the reminder to change the password, then the guide.
        assert!(position("✅ Đã nhận thanh toán") < position("one@example.test|first"));
        assert!(position("one@example.test|first") < position("Hãy đổi mật khẩu"));
        assert!(position("Hãy đổi mật khẩu") < position("📖 Hướng dẫn sử dụng:"));
        assert!(text.ends_with("Không đổi mật khẩu."), "{text}");
    }

    #[test]
    fn late_money_is_not_called_a_payment_and_says_who_to_write_to_in_both_languages() {
        let expired = order("awaiting_payment", -1);
        let text = |language| {
            let message: Value = serde_json::to_value(super::late_payment(
                123,
                language,
                &expired,
                1_350_000,
                "@shop_owner",
            ))
            .unwrap();

            message["text"].as_str().unwrap().to_owned()
        };

        let english = text(Language::English);
        assert!(english.contains("We received 1,350,000₫"), "{english}");
        assert!(english.contains("had already expired"), "{english}");
        assert!(
            english.contains(&format!(
                "Write to @shop_owner with order {}",
                expired.reference
            )),
            "{english}"
        );
        assert!(!english.contains("Payment received"), "{english}");

        let vietnamese = text(Language::Vietnamese);
        assert!(vietnamese.contains("Đã nhận 1,350,000₫"), "{vietnamese}");
        assert!(
            vietnamese.contains(&format!(
                "Nhắn @shop_owner kèm mã đơn {}",
                expired.reference
            )),
            "{vietnamese}"
        );
        assert!(!vietnamese.contains("Đã nhận thanh toán"), "{vietnamese}");
    }

    #[test]
    fn an_expired_order_tells_the_buyer_not_to_transfer_for_it() {
        let expired = order("awaiting_payment", -1);

        let english = text_of(Language::English, &expired);
        assert!(english.contains("no longer valid"), "{english}");
        assert!(english.contains("do not transfer"), "{english}");
        assert!(!english.contains("still matched"), "{english}");

        let vietnamese = text_of(Language::Vietnamese, &expired);
        assert!(vietnamese.contains("không còn hiệu lực"), "{vietnamese}");
        assert!(vietnamese.contains("không chuyển khoản"), "{vietnamese}");
        assert!(!vietnamese.contains("vẫn được khớp"), "{vietnamese}");
    }

    #[test]
    fn an_order_still_inside_its_window_is_waiting_for_the_transfer() {
        let open = order("awaiting_payment", 3);

        assert!(text_of(Language::English, &open).contains("No transfer has arrived"));
    }
}
