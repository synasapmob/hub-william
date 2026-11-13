use axum::{
    Router,
    extract::DefaultBodyLimit,
    middleware::from_fn_with_state,
    routing::{delete, get, post, put},
};
use utoipa::OpenApi;

use crate::{
    api::limits::{Limit, UserLimit, limit_by_user},
    core::AppState,
};

use super::{
    dashboard_session,
    icons::{MAXIMUM_ICON_BYTES, assign_icon, icon_library, list_icons, upload_icon},
    images::{MAXIMUM_IMAGE_BYTES, get_image, upload_image},
    orders::{cancel_order, list_orders, list_sales, pay_order},
    push::announce,
    revenue::revenue,
    service_listings::{
        create_service_listing, delete_service_listing, list_service_listings, list_service_sales,
        update_service_listing, verify_service_account,
    },
    service_prices::{list_service_models, save_service_model},
    staff::{add_staff, change_role, list_staff, remove_staff},
    stock::{
        add_accounts, change_stock, create_product, delete_account, delete_product, edit_accounts,
        list_accounts, list_products, reveal_accounts, search_accounts, update_account,
        update_product,
    },
};

pub(crate) fn routes(state: &AppState) -> Router<AppState> {
    Router::new()
        .route("/dashboard/session", get(dashboard_session))
        .route(
            "/dashboard/telegram/products",
            get(list_products).post(create_product),
        )
        .route(
            "/dashboard/telegram/products/{slug}",
            put(update_product).delete(delete_product),
        )
        .route(
            "/dashboard/telegram/products/{slug}/stock",
            post(change_stock),
        )
        .route(
            "/dashboard/telegram/products/{slug}/accounts",
            get(list_accounts).post(add_accounts).put(edit_accounts),
        )
        .route("/dashboard/telegram/accounts", get(search_accounts))
        .route(
            "/dashboard/telegram/accounts/{id}",
            delete(delete_account).put(update_account),
        )
        .route(
            "/dashboard/telegram/accounts/reveal",
            post(reveal_accounts).layer(from_fn_with_state(
                UserLimit::new(state, Limit::SecretReveal),
                limit_by_user,
            )),
        )
        // The picture is the one body here that is more than a few lines of JSON.
        .route(
            "/dashboard/images",
            post(upload_image).layer(DefaultBodyLimit::max(MAXIMUM_IMAGE_BYTES + 1024)),
        )
        .route("/dashboard/images/{id}", get(get_image))
        // An icon is a picture too, kept in the icon bucket and not in the database.
        .route(
            "/dashboard/icons",
            get(list_icons)
                .post(upload_icon)
                .layer(DefaultBodyLimit::max(MAXIMUM_ICON_BYTES + 1024)),
        )
        .route("/dashboard/icons/library", get(icon_library))
        .route("/dashboard/icons/providers/{provider}", put(assign_icon))
        .route("/dashboard/telegram/announcements", post(announce))
        .route("/dashboard/telegram/orders", get(list_orders))
        .route(
            "/dashboard/telegram/orders/{reference}/pay",
            post(pay_order),
        )
        .route(
            "/dashboard/telegram/orders/{reference}/cancel",
            post(cancel_order),
        )
        .route("/dashboard/telegram/sales", get(list_sales))
        .route("/dashboard/telegram/revenue", get(revenue))
        .route(
            "/dashboard/service/listings",
            get(list_service_listings).post(create_service_listing),
        )
        .route(
            "/dashboard/service/listings/{id}",
            put(update_service_listing).delete(delete_service_listing),
        )
        .route("/dashboard/service/verify", post(verify_service_account))
        .route("/dashboard/service/sales", get(list_service_sales))
        .route(
            "/dashboard/service/models",
            get(list_service_models).put(save_service_model),
        )
        .route("/dashboard/staff", get(list_staff).post(add_staff))
        .route(
            "/dashboard/staff/{user_id}",
            put(change_role).delete(remove_staff),
        )
}

#[derive(OpenApi)]
#[openapi(
    paths(
        super::dashboard_session,
        super::stock::list_products,
        super::stock::create_product,
        super::stock::update_product,
        super::stock::change_stock,
        super::stock::add_accounts,
        super::stock::edit_accounts,
        super::stock::list_accounts,
        super::stock::search_accounts,
        super::stock::delete_account,
        super::stock::reveal_accounts,
        super::stock::update_account,
        super::stock::delete_product,
        super::images::upload_image,
        super::images::get_image,
        super::icons::list_icons,
        super::icons::icon_library,
        super::icons::upload_icon,
        super::icons::assign_icon,
        super::push::announce,
        super::orders::list_orders,
        super::orders::pay_order,
        super::orders::cancel_order,
        super::orders::list_sales,
        super::revenue::revenue,
        super::service_prices::list_service_models,
        super::service_prices::save_service_model,
        super::service_listings::list_service_listings,
        super::service_listings::verify_service_account,
        super::service_listings::create_service_listing,
        super::service_listings::update_service_listing,
        super::service_listings::delete_service_listing,
        super::service_listings::list_service_sales,
        super::staff::list_staff,
        super::staff::add_staff,
        super::staff::change_role,
        super::staff::remove_staff
    ),
    components(schemas(
        super::DashboardAccount,
        super::DashboardSession,
        super::access::Permission,
        super::access::Role,
        super::icons::AssignIcon,
        super::icons::DashboardIcons,
        super::icons::IconAssigned,
        super::icons::IconAssignment,
        super::icons::IconLibrary,
        super::icons::LibraryIcon,
        super::icons::UploadedIcon,
        super::images::UploadedImage,
        super::orders::DashboardOrder,
        super::orders::DashboardOrders,
        super::orders::DashboardSales,
        super::orders::OrderCounts,
        super::orders::PayOrder,
        super::orders::PaymentMethod,
        super::orders::SettledOrder,
        super::push::Announced,
        super::push::Announcement,
        super::revenue::DashboardRevenue,
        super::revenue::RevenueDay,
        super::revenue::RevenueItem,
        super::revenue::RevenueSeller,
        super::service_listings::CreateListing,
        super::service_listings::DashboardListing,
        super::service_listings::DashboardListings,
        super::service_listings::DashboardTicketSale,
        super::service_listings::DashboardTicketSales,
        super::service_listings::UpdateListing,
        super::service_listings::VerifiedAccount,
        super::service_listings::VerifyAccount,
        super::service_prices::SaveServiceModel,
        super::service_prices::DashboardServiceModel,
        super::service_prices::DashboardServiceModels,
        super::staff::AddStaff,
        super::staff::ChangeRole,
        super::staff::StaffList,
        super::staff::StaffMember,
        super::stock::AccountList,
        super::stock::AccountUpdated,
        super::stock::AccountRemoved,
        super::stock::AccountsLoaded,
        super::stock::CreateProduct,
        super::stock::DashboardProduct,
        super::stock::DashboardProducts,
        super::stock::LoadAccounts,
        super::stock::AccountsEdited,
        super::stock::EditAccounts,
        super::stock::RevealAccounts,
        super::stock::RevealedAccount,
        super::stock::RevealedAccounts,
        super::stock::UpdateAccount,
        crate::api::telegram::accounts::AccountCounts,
        crate::api::telegram::accounts::AccountPage,
        crate::api::telegram::accounts::StockAccount,
        super::stock::StockChange,
        super::stock::UpdateProduct
    )),
    tags((name = "dashboard", description = "The shop's back office: who may use it, and its Telegram stock"))
)]
pub(crate) struct DashboardApi;
