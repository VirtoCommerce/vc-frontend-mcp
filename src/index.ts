#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Agent } from "undici";
import { z } from "zod";

type JsonObject = Record<string, unknown>;

type ConnectionInput = {
  base_url?: string;
  storefront_url?: string;
};

type LastCheckoutState = {
  cart_id: string;
  store_id?: string;
  buyer_id?: string;
  organization_id?: string;
  language?: string;
  checkout_id?: string;
  continue_url?: string;
  ucp_base_url?: string;
  storefront_url?: string;
  updated_at: string;
};

type RuntimeContextState = {
  ucp_base_url: string;
  store_id?: string;
  store_source?: string;
  storefront_url?: string;
  storefront_source?: string;
  handoff_url_template?: string;
  profile_discovered_at?: string;
  updated_at: string;
};

type StorefrontDiscovery = {
  store_id?: string;
  store_source?: string;
  storefront_url?: string;
  storefront_source?: string;
  handoff_url_template?: string;
};

const connectionInput = {
  base_url: z.string().url().optional().describe([
    "Virto Commerce platform/UCP base URL, for example 'https://localhost:5001'.",
    "If the user mentions a store URL in the prompt, pass it on the first tool call; the MCP server remembers it for later calls.",
  ].join(" ")),
  storefront_url: z.string().url().optional().describe([
    "Optional explicit hosted storefront URL override, for example 'https://localhost:3000'.",
    "Usually omit it: MCP discovers storefront URL from UCP discovery or handoff responses.",
  ].join(" ")),
};

const cartLineItemInput = z.object({
  id: z.string().optional().describe("Existing cart line item id. Use it when changing/removing a known line."),
  product_id: z.string().optional().describe("Stable UCP product id from search_products/get_product."),
  quantity: z.number().int().min(0).describe("Desired quantity. Use 0 only with an existing line item id to remove it."),
});

const cartContextInput = {
  ...connectionInput,
  store_id: z.string().optional().describe("Virto store id. Defaults to discovered UCP default_store_id, then UCP_STORE_ID."),
  currency: z.string().optional().describe("Currency code. Defaults to UCP_CURRENCY."),
  language: z.string().optional().describe("Language/culture code. Defaults to UCP_LANGUAGE."),
  cart_name: z.string().optional().describe("Cart name. Defaults to 'default'."),
  cart_type: z.string().optional().describe("Cart type. Defaults to 'cart'."),
  buyer_id: z.string().optional().describe("Delegated buyer user id for B2B/B2C buyer-aware carts."),
  organization_id: z.string().optional().describe("Delegated buyer organization id for B2B carts."),
};

const checkoutAddressInput = z.object({
  id: z.string().optional().describe("Optional address id/key."),
  name: z.string().optional().describe("Optional address display name."),
  organization: z.string().optional().describe("Optional company or organization name."),
  first_name: z.string().trim().min(1).describe("Recipient first name. Required: if the buyer gives a delivery address but no recipient name, ask who the order is for before checkout."),
  last_name: z.string().trim().min(1).describe("Recipient last name. Required: if the buyer gives a delivery address but no recipient name, ask who the order is for before checkout."),
  line1: z.string().trim().min(1).describe("Street address, building, house, or avenue. Example: '1 Main St'."),
  line2: z.string().optional().describe("Apartment, suite, unit, or extra address line. Example: 'Apt 100'."),
  city: z.string().trim().min(1).describe("City. Example: 'Seattle'."),
  region: z.string().optional().describe("State, province, oblast, or region display name. Prefer calling list_regions and using the platform value when the country has regions."),
  region_id: z.string().optional().describe("State/province/region platform id from list_regions when known."),
  postal_code: z.string().trim().min(1).describe("Postal or ZIP code. Required: ask the buyer for it before checkout because hosted checkout address edit forms require it."),
  country_code: z.string().trim().min(1).describe("Virto platform country id from resolve_country, such as 'USA'. ISO2 such as 'US' is accepted as input, but prefer resolve_country before checkout."),
  country_name: z.string().optional().describe("Country display name. Example: 'United States'. UCP may replace it with the platform country name."),
  phone: z.string().optional().describe("Recipient phone number."),
  email: z.string().email().optional().describe("Recipient email address. Ask for it when possible because hosted checkout address edit forms require it."),
});

const checkoutHintInput = {
  buyer_email: z.string().email().optional().describe("Optional buyer email hint for hosted checkout. UCP can copy it into address email when address.email is missing."),
  buyer_name: z.string().optional().describe("Optional buyer display name hint for hosted checkout. UCP can split it into first_name/last_name when address names are missing."),
  buyer_phone: z.string().optional().describe("Optional buyer phone hint for hosted checkout. UCP can copy it into address phone when address.phone is missing."),
  shipping_address: checkoutAddressInput.optional().describe("Structured shipping/delivery address. If the buyer gives an address in natural language, parse it into this object. Resolve country with resolve_country and regions with list_regions before checkout. Do not put delivery address into notes. first_name, last_name, and postal_code are required; ask the buyer who the order is for before checkout if first_name or last_name is missing."),
  billing_address: checkoutAddressInput.optional().describe("Structured billing address. Use the same value as shipping_address unless the buyer provides a different billing address."),
  payment_handler: z.string().optional().describe("Preferred payment handler. Defaults to hosted_checkout."),
  notes: z.string().optional().describe("Optional order comments only. Do not put shipping or delivery address here."),
};

const config = {
  hasExplicitBaseUrl: Boolean(process.env.UCP_BASE_URL),
  baseUrl: trimTrailingSlash(process.env.UCP_BASE_URL ?? "https://localhost:5001"),
  storefrontUrl: normalizeOptionalUrl(process.env.UCP_STOREFRONT_URL),
  storeId: process.env.UCP_STORE_ID,
  currency: process.env.UCP_CURRENCY ?? "USD",
  language: process.env.UCP_LANGUAGE ?? "en-US",
  allowSelfSigned: (process.env.UCP_ALLOW_SELF_SIGNED ?? "true").toLowerCase() !== "false",
  bearerToken: process.env.UCP_BEARER_TOKEN,
  stateFile: process.env.UCP_MCP_STATE_FILE ?? join(homedir(), ".vc-frontend-mcp", "last-checkout.json"),
  contextFile: process.env.UCP_MCP_CONTEXT_FILE ?? join(homedir(), ".vc-frontend-mcp", "context.json"),
};

let runtimeContextCache: RuntimeContextState | undefined;

const dispatcher = config.allowSelfSigned
  ? new Agent({ connect: { rejectUnauthorized: false } })
  : undefined;

const server = new McpServer({
  name: "vc-frontend-mcp",
  version: "0.1.0",
});

server.tool(
  "get_store_capabilities",
  "Discover the Virto Commerce UCP profile, available endpoints, headers, payment handlers, and tool capabilities.",
  {
    ...connectionInput,
  },
  async ({ base_url, storefront_url }) => jsonResult(await discoverStoreContext({ base_url, storefront_url })),
);

server.tool(
  "list_countries",
  [
    "List or search countries from the Virto Commerce platform dictionary.",
    "Use this before checkout when the buyer gives a country name and you need the platform country id.",
    "Do not invent country ids; use resolve_country/list_countries.",
  ].join(" "),
  {
    ...connectionInput,
    query: z.string().optional().describe("Optional country id/name search text, for example 'US', 'USA', or 'United States'."),
    limit: z.number().int().min(1).max(250).optional().describe("Maximum countries to return. Defaults to the UCP server limit."),
  },
  async ({ base_url, storefront_url, query, limit }) => {
    const params = new URLSearchParams();
    appendOptional(params, "query", query);
    appendOptional(params, "limit", limit?.toString());

    return jsonResult(await ucpGet(`/ucp/v1/geography/countries?${params}`, { base_url, storefront_url }));
  },
);

server.tool(
  "resolve_country",
  [
    "Resolve a country query to the Virto Commerce platform country id.",
    "Accepts ISO2, ISO3, or platform country name. Example: 'KZ' resolves to 'KAZ'.",
    "Use the returned country.id as shipping_address.country_code.",
  ].join(" "),
  {
    ...connectionInput,
    query: z.string().describe("Country query from the buyer or agent, for example 'US', 'USA', or 'United States'."),
  },
  async ({ base_url, storefront_url, query }) => {
    const params = new URLSearchParams({ query });
    return jsonResult(await ucpGet(`/ucp/v1/geography/countries/resolve?${params}`, { base_url, storefront_url }));
  },
);

server.tool(
  "list_regions",
  [
    "List state/province/region values from the Virto Commerce platform dictionary for a country.",
    "Call resolve_country first, then pass the returned country.id.",
    "Use the returned region.id as shipping_address.region_id when the buyer gave a province/region. City remains free text.",
  ].join(" "),
  {
    ...connectionInput,
    country_id: z.string().describe("Virto Commerce platform country id, usually from resolve_country. ISO2 is accepted by UCP when the platform can resolve it."),
  },
  async ({ base_url, storefront_url, country_id }) => jsonResult(await ucpGet(`/ucp/v1/geography/countries/${encodeURIComponent(country_id)}/regions`, { base_url, storefront_url })),
);

server.tool(
  "search_products",
  [
    "Search products through UCP.",
    "Use broad natural-language queries such as 'iphone', 'samsung phone', or 'printer'.",
    "Prices are minor units: USD $500.00 is 50000.",
    "For attributes like memory, storage, or color, call get_product for candidates and inspect attributes.",
  ].join(" "),
  {
    ...connectionInput,
    query: z.string().describe("Search text, for example 'iphone', 'smartphone', 'printer', or 'samsung phone'."),
    store_id: z.string().optional().describe("Virto store id. Defaults to discovered UCP default_store_id, then UCP_STORE_ID."),
    currency: z.string().optional().describe("Currency code. Defaults to UCP_CURRENCY."),
    language: z.string().optional().describe("Language/culture code. Defaults to UCP_LANGUAGE."),
    price_min: z.number().int().nonnegative().optional().describe("Minimum price in minor units."),
    price_max: z.number().int().nonnegative().optional().describe("Maximum price in minor units."),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum number of products to return."),
  },
  async ({ base_url, storefront_url, query, store_id, currency, language, price_min, price_max, limit }) => {
    const effectiveStoreId = await getEffectiveStoreId(store_id, { base_url, storefront_url });
    const body = {
      query,
      context: {
        store_id: effectiveStoreId,
        currency: currency ?? config.currency,
        language: language ?? config.language,
      },
      filters: {
        price: {
          min: price_min,
          max: price_max,
        },
      },
      pagination: {
        limit: limit ?? 10,
      },
    };

    return jsonResult(await ucpPost("/ucp/v1/catalog/search", body, { base_url, storefront_url }));
  },
);

server.tool(
  "get_product",
  [
    "Get detailed product data from UCP by product id.",
    "Use this after search_products to inspect price, image_url, availability, attributes, and variations.",
  ].join(" "),
  {
    ...connectionInput,
    id: z.string().describe("Stable UCP product id from search_products."),
    store_id: z.string().optional().describe("Virto store id. Defaults to discovered UCP default_store_id, then UCP_STORE_ID."),
    currency: z.string().optional().describe("Currency code. Defaults to UCP_CURRENCY."),
    language: z.string().optional().describe("Language/culture code. Defaults to UCP_LANGUAGE."),
  },
  async ({ base_url, storefront_url, id, store_id, currency, language }) => {
    const effectiveStoreId = await getEffectiveStoreId(store_id, { base_url, storefront_url });
    const params = new URLSearchParams({
      store_id: effectiveStoreId ?? "",
      currency: currency ?? config.currency,
      culture_name: language ?? config.language,
    });

    return jsonResult(await ucpGet(`/ucp/v1/catalog/products/${encodeURIComponent(id)}?${params}`, { base_url, storefront_url }));
  },
);

server.tool(
  "create_cart",
  [
    "Create a UCP cart through XCart.",
    "Use product ids returned by search_products/get_product.",
    "The response includes cart id, line items, totals, coupons, messages, and continue_url.",
    "For later cart changes, reuse the returned cart.id and cart.buyer_id with update_cart instead of creating another cart.",
  ].join(" "),
  {
    line_items: z.array(cartLineItemInput).min(1).describe("Initial cart lines. Current Virto UCP adapter creates a cart by adding the first item."),
    coupons: z.array(z.string()).optional().describe("Coupon codes to apply after the cart is created."),
    ...cartContextInput,
  },
  async ({ base_url, storefront_url, line_items, coupons, store_id, currency, language, cart_name, cart_type, buyer_id, organization_id }) => {
    const effectiveStoreId = await getEffectiveStoreId(store_id, { base_url, storefront_url });
    const body = cartBody({
      line_items,
      coupons,
      store_id: effectiveStoreId,
      currency,
      language,
      cart_name,
      cart_type,
      buyer_id,
      organization_id,
    });

    return jsonResult(await ucpPost("/ucp/v1/carts", body, { base_url, storefront_url }));
  },
);

server.tool(
  "list_carts",
  [
    "List buyer-scoped UCP carts.",
    "This is a Virto Commerce extension over the UCP cart flow.",
    "A buyer_id is required so the agent does not request a global anonymous cart list.",
  ].join(" "),
  {
    ...connectionInput,
    buyer_id: z.string().describe("Buyer user id whose carts should be listed."),
    organization_id: z.string().optional().describe("Buyer organization id for B2B cart context."),
    store_id: z.string().optional().describe("Virto store id. Defaults to discovered UCP default_store_id, then UCP_STORE_ID."),
    currency: z.string().optional().describe("Currency code. Defaults to UCP_CURRENCY."),
    language: z.string().optional().describe("Language/culture code. Defaults to UCP_LANGUAGE."),
    cart_type: z.string().optional().describe("Cart type. Defaults to 'cart' on the server."),
    cursor: z.string().optional().describe("Pagination cursor."),
    limit: z.number().int().min(1).max(50).optional().describe("Maximum number of carts to return."),
    sort: z.string().optional().describe("Optional XCart sort expression."),
  },
  async ({ base_url, storefront_url, buyer_id, organization_id, store_id, currency, language, cart_type, cursor, limit, sort }) => {
    const effectiveStoreId = await getEffectiveStoreId(store_id, { base_url, storefront_url });
    const params = new URLSearchParams({
      store_id: effectiveStoreId ?? "",
      currency: currency ?? config.currency,
      culture_name: language ?? config.language,
      buyer_id,
    });

    appendOptional(params, "organization_id", organization_id);
    appendOptional(params, "cart_type", cart_type);
    appendOptional(params, "cursor", cursor);
    appendOptional(params, "limit", limit?.toString());
    appendOptional(params, "sort", sort);

    return jsonResult(await ucpGet(`/ucp/v1/carts?${params}`, { base_url, storefront_url }));
  },
);

server.tool(
  "get_cart",
  "Get a UCP cart by cart id. Returns line items, totals, coupons, promotion/tax messages, and continue_url.",
  {
    ...connectionInput,
    cart_id: z.string().describe("UCP cart id."),
    store_id: z.string().optional().describe("Virto store id. Defaults to discovered UCP default_store_id, then UCP_STORE_ID."),
    currency: z.string().optional().describe("Currency code. Defaults to UCP_CURRENCY."),
    language: z.string().optional().describe("Language/culture code. Defaults to UCP_LANGUAGE."),
  },
  async ({ base_url, storefront_url, cart_id, store_id, currency, language }) => {
    const effectiveStoreId = await getEffectiveStoreId(store_id, { base_url, storefront_url });
    const params = new URLSearchParams({
      store_id: effectiveStoreId ?? "",
      currency: currency ?? config.currency,
      culture_name: language ?? config.language,
    });

    return jsonResult(await ucpGet(`/ucp/v1/carts/${encodeURIComponent(cart_id)}?${params}`, { base_url, storefront_url }));
  },
);

server.tool(
  "update_cart",
  [
    "Replace the desired UCP cart state.",
    "Send the complete desired line_items and coupons after the change.",
    "To remove an item, omit it from line_items or send its id with quantity 0.",
    "To change quantity, keep the line id and set the new quantity.",
    "Use this for follow-up cart changes when a cart_id is known; do not create a new cart as a fallback.",
    "Pass buyer_id when it is available from create_cart/list_carts; the UCP adapter can also resolve the cart owner by cart_id.",
  ].join(" "),
  {
    cart_id: z.string().describe("UCP cart id."),
    line_items: z.array(cartLineItemInput).describe("Complete desired cart lines after the update."),
    coupons: z.array(z.string()).optional().describe("Complete desired coupon list after the update."),
    ...cartContextInput,
  },
  async ({ base_url, storefront_url, cart_id, line_items, coupons, store_id, currency, language, cart_name, cart_type, buyer_id, organization_id }) => {
    const effectiveStoreId = await getEffectiveStoreId(store_id, { base_url, storefront_url });
    const body = cartBody({
      line_items,
      coupons,
      store_id: effectiveStoreId,
      currency,
      language,
      cart_name,
      cart_type,
      buyer_id,
      organization_id,
    });

    return jsonResult(await ucpPut(`/ucp/v1/carts/${encodeURIComponent(cart_id)}`, body, { base_url, storefront_url }));
  },
);

server.tool(
  "create_checkout",
  [
    "Create a UCP checkout snapshot from an existing cart.",
    "This tool does not finish handoff and may not return continue_url.",
    "When the buyer asks to checkout, prefer checkout_and_handoff instead.",
    "Use this after the cart is final enough for buyer handoff.",
    "If the buyer provides a delivery address, parse it into shipping_address fields; do not put delivery address into notes.",
    "Recipient first_name and last_name are required for shipping_address/billing_address. If the buyer gives an address but no recipient name, ask who the order is for before calling this tool.",
    "For editable hosted checkout address forms, collect recipient first_name, last_name, email, and postal_code when possible.",
    "When the buyer gives country or region as text, call resolve_country/list_regions first and use platform ids in shipping_address.",
    "country_code may be ISO2 in tool input; UCP normalizes country and region through Virto platform dictionaries before writing XCart.",
    "Use billing_address equal to shipping_address unless the buyer provides a different billing address.",
    "Delivery method and payment details are still completed in hosted storefront checkout.",
  ].join(" "),
  {
    ...connectionInput,
    cart_id: z.string().describe("Cart id returned by create_cart/list_carts/get_cart."),
    store_id: z.string().optional().describe("Virto store id. Defaults to discovered UCP default_store_id, then UCP_STORE_ID."),
    currency: z.string().optional().describe("Currency code. Defaults to UCP_CURRENCY."),
    language: z.string().optional().describe("Language/culture code. Defaults to UCP_LANGUAGE."),
    buyer_id: z.string().optional().describe("Buyer id from the cart response. Prefer passing it; if omitted, UCP will try to resolve the cart owner by cart id."),
    organization_id: z.string().optional().describe("Buyer organization id for B2B checkout context."),
    ...checkoutHintInput,
  },
  async ({ base_url, storefront_url, cart_id, store_id, currency, language, buyer_id, organization_id, buyer_email, buyer_name, buyer_phone, shipping_address, billing_address, payment_handler, notes }) => {
    await ensureStorefrontDiscovered({ base_url, storefront_url });
    const effectiveStoreId = await getEffectiveStoreId(store_id, { base_url, storefront_url });

    return jsonResult(await ucpPost("/ucp/v1/checkouts", checkoutBody({
      cart_id,
      store_id: effectiveStoreId,
      currency,
      language,
      buyer_id,
      organization_id,
      buyer_email,
      buyer_name,
      buyer_phone,
      shipping_address,
      billing_address,
      payment_handler,
      notes,
    }), { base_url, storefront_url }));
  },
);

server.tool(
  "update_checkout",
  [
    "Update checkout address hints before payment.",
    "Use this when the buyer provides or changes the shipping address after checkout/handoff was created.",
    "Pass structured shipping_address and billing_address; do not put delivery address into notes.",
    "Recipient first_name and last_name are required for shipping_address/billing_address. If the buyer gives an address but no recipient name, ask who the order is for before calling this tool.",
    "For editable hosted checkout address forms, collect recipient first_name, last_name, email, and postal_code when possible.",
    "When the buyer gives country or region as text, call resolve_country/list_regions first and use platform ids in shipping_address.",
    "country_code may be ISO2 in tool input; UCP normalizes country and region through Virto platform dictionaries before writing XCart.",
    "After this tool succeeds, call handoff_checkout again and return the fresh continue_url.",
  ].join(" "),
  {
    ...connectionInput,
    checkout_id: z.string().describe("Checkout id returned by create_checkout or checkout_and_handoff. In the current stateless MVP this is the cart id."),
    cart_id: z.string().optional().describe("Cart id. Defaults to checkout_id."),
    store_id: z.string().optional().describe("Virto store id. Defaults to discovered UCP default_store_id, then UCP_STORE_ID."),
    currency: z.string().optional().describe("Currency code. Defaults to UCP_CURRENCY."),
    language: z.string().optional().describe("Language/culture code. Defaults to UCP_LANGUAGE."),
    buyer_id: z.string().optional().describe("Buyer id from the cart response. Prefer passing it; if omitted, UCP will try to resolve the cart owner by cart id."),
    organization_id: z.string().optional().describe("Buyer organization id for B2B checkout context."),
    ...checkoutHintInput,
  },
  async ({ base_url, storefront_url, checkout_id, cart_id, store_id, currency, language, buyer_id, organization_id, buyer_email, buyer_name, buyer_phone, shipping_address, billing_address, payment_handler, notes }) => {
    await ensureStorefrontDiscovered({ base_url, storefront_url });
    const effectiveStoreId = await getEffectiveStoreId(store_id, { base_url, storefront_url });

    const effectiveCartId = cart_id ?? checkout_id;
    const checkout = await ucpPatch(`/ucp/v1/checkouts/${encodeURIComponent(checkout_id)}`, checkoutBody({
      cart_id: effectiveCartId,
      store_id: effectiveStoreId,
      currency,
      language,
      buyer_id,
      organization_id,
      buyer_email,
      buyer_name,
      buyer_phone,
      shipping_address,
      billing_address,
      payment_handler,
      notes,
    }), { base_url, storefront_url });

    return jsonResult({
      result: checkout,
      next_step: !isErrorResponse(checkout)
        ? {
            tool: "handoff_checkout",
            reason: "Address was updated; create a fresh hosted checkout URL with the latest address snapshot.",
            arguments: {
              checkout_id,
              cart_id: effectiveCartId,
              store_id: effectiveStoreId,
              base_url,
              storefront_url,
              buyer_id,
              organization_id,
              language: language ?? config.language,
              shipping_address,
              billing_address: billing_address ?? shipping_address,
              payment_handler: payment_handler ?? "hosted_checkout",
            },
          }
        : undefined,
    });
  },
);

server.tool(
  "get_payment_handlers",
  "Get payment handlers available for a UCP checkout. MVP exposes hosted_checkout and marks direct/native handlers as future work.",
  {
    ...connectionInput,
    checkout_id: z.string().describe("Checkout id returned by create_checkout. In the current stateless MVP this is the cart id."),
  },
  async ({ base_url, storefront_url, checkout_id }) => jsonResult(await ucpGet(`/ucp/v1/checkouts/${encodeURIComponent(checkout_id)}/payment-handlers`, { base_url, storefront_url })),
);

server.tool(
  "handoff_checkout",
  [
    "Create a hosted checkout handoff URL for an existing checkout.",
    "Use this after create_checkout when the buyer is ready to finish in the Virto storefront.",
    "If the buyer provides a delivery address, parse it into shipping_address fields; do not put delivery address into notes.",
    "Recipient first_name and last_name are required for shipping_address/billing_address. If the buyer gives an address but no recipient name, ask who the order is for before calling this tool.",
    "For editable hosted checkout address forms, collect recipient first_name, last_name, email, and postal_code when possible.",
    "When the buyer gives country or region as text, call resolve_country/list_regions first and use platform ids in shipping_address.",
    "country_code may be ISO2 in tool input; UCP normalizes country and region through Virto platform dictionaries before writing XCart.",
    "Use billing_address equal to shipping_address unless the buyer provides a different billing address.",
    "Return the checkout.continue_url to the buyer.",
  ].join(" "),
  {
    ...connectionInput,
    checkout_id: z.string().describe("Checkout id returned by create_checkout. In the current stateless MVP this is the cart id."),
    cart_id: z.string().optional().describe("Cart id. Defaults to checkout_id."),
    store_id: z.string().optional().describe("Virto store id. Defaults to discovered UCP default_store_id, then UCP_STORE_ID."),
    currency: z.string().optional().describe("Currency code. Defaults to UCP_CURRENCY."),
    language: z.string().optional().describe("Language/culture code. Defaults to UCP_LANGUAGE."),
    buyer_id: z.string().optional().describe("Buyer id from the cart response. Prefer passing it; if omitted, UCP will try to resolve the cart owner by cart id."),
    organization_id: z.string().optional().describe("Buyer organization id for B2B checkout context."),
    ...checkoutHintInput,
  },
  async ({ base_url, storefront_url, checkout_id, cart_id, store_id, currency, language, buyer_id, organization_id, buyer_email, buyer_name, buyer_phone, shipping_address, billing_address, payment_handler, notes }) => {
    await ensureStorefrontDiscovered({ base_url, storefront_url });
    const effectiveStoreId = await getEffectiveStoreId(store_id, { base_url, storefront_url });

    const effectiveCartId = cart_id ?? checkout_id;
    const handoff = await ucpPost(`/ucp/v1/checkouts/${encodeURIComponent(checkout_id)}/handoff`, checkoutBody({
      cart_id: effectiveCartId,
      store_id: effectiveStoreId,
      currency,
      language,
      buyer_id,
      organization_id,
      buyer_email,
      buyer_name,
      buyer_phone,
      shipping_address,
      billing_address,
      payment_handler,
      notes,
    }), { base_url, storefront_url });

    if (!isErrorResponse(handoff)) {
      await rememberHandoffContext(handoff, { base_url, storefront_url });
      await saveLastCheckout({
        cart_id: effectiveCartId,
        store_id: effectiveStoreId,
        buyer_id,
        organization_id,
        language: language ?? config.language,
        checkout_id,
        continue_url: readContinueUrl(handoff),
        ucp_base_url: await getEffectiveBaseUrl({ base_url }),
        storefront_url: await getEffectiveStorefrontUrl(readContinueUrl(handoff)),
        updated_at: new Date().toISOString(),
      });
    }

    return jsonResult({
      result: handoff,
      mcp_context: !isErrorResponse(handoff) ? await getPublicRuntimeContext() : undefined,
      last_checkout: !isErrorResponse(handoff)
        ? {
            cart_id: effectiveCartId,
            buyer_id,
            organization_id,
            language: language ?? config.language,
            checkout_id,
          }
        : undefined,
      next_step_after_payment: !isErrorResponse(handoff)
        ? {
            tool: "track_order",
            arguments: {
              cart_id: effectiveCartId,
              buyer_id,
              language: language ?? config.language,
            },
          }
        : undefined,
    });
  },
);

server.tool(
  "checkout_and_handoff",
  [
    "Create a UCP checkout and immediately create the hosted storefront handoff URL.",
    "Use this as the default tool when the buyer asks to checkout, pay, place the order, or continue to storefront checkout.",
    "Return checkout.continue_url to the buyer. Do not stop after the checkout snapshot.",
    "Remember cart_id and buyer_id from the response. After the buyer pays in the storefront, use track_order with cart_id and buyer_id.",
    "Do not use ucp_session for order tracking; it is a short-lived handoff token only.",
    "If the buyer provides a delivery address, parse it into shipping_address fields; do not put delivery address into notes.",
    "Recipient first_name and last_name are required for shipping_address/billing_address. If the buyer gives an address but no recipient name, ask who the order is for before calling this tool.",
    "For editable hosted checkout address forms, collect recipient first_name, last_name, email, and postal_code when possible.",
    "When the buyer gives country or region as text, call resolve_country/list_regions first and use platform ids in shipping_address.",
    "country_code may be ISO2 in tool input; UCP normalizes country and region through Virto platform dictionaries before writing XCart.",
    "Use billing_address equal to shipping_address unless the buyer provides a different billing address.",
    "Delivery method and payment details are still completed in the hosted storefront checkout.",
  ].join(" "),
  {
    ...connectionInput,
    cart_id: z.string().describe("Cart id returned by create_cart/list_carts/get_cart."),
    store_id: z.string().optional().describe("Virto store id. Defaults to discovered UCP default_store_id, then UCP_STORE_ID."),
    currency: z.string().optional().describe("Currency code. Defaults to UCP_CURRENCY."),
    language: z.string().optional().describe("Language/culture code. Defaults to UCP_LANGUAGE."),
    buyer_id: z.string().optional().describe("Buyer id from the cart response. Prefer passing it; if omitted, UCP will try to resolve the cart owner by cart id."),
    organization_id: z.string().optional().describe("Buyer organization id for B2B checkout context."),
    ...checkoutHintInput,
  },
  async ({ base_url, storefront_url, cart_id, store_id, currency, language, buyer_id, organization_id, buyer_email, buyer_name, buyer_phone, shipping_address, billing_address, payment_handler, notes }) => {
    await ensureStorefrontDiscovered({ base_url, storefront_url });
    const effectiveStoreId = await getEffectiveStoreId(store_id, { base_url, storefront_url });

    const body = checkoutBody({
      cart_id,
      store_id: effectiveStoreId,
      currency,
      language,
      buyer_id,
      organization_id,
      buyer_email,
      buyer_name,
      buyer_phone,
      shipping_address,
      billing_address,
      payment_handler,
      notes,
    });

    const connection = { base_url, storefront_url };
    const checkout = await ucpPost("/ucp/v1/checkouts", body, connection);
    if (isErrorResponse(checkout)) {
      return jsonResult({ ok: false, step: "create_checkout", result: checkout });
    }

    const checkoutId = readCheckoutId(checkout) ?? cart_id;
    const handoff = await ucpPost(`/ucp/v1/checkouts/${encodeURIComponent(checkoutId)}/handoff`, body, connection);
    if (isErrorResponse(handoff)) {
      return jsonResult({ ok: false, step: "handoff_checkout", checkout, result: handoff });
    }

    const effectiveBuyerId = readBuyerId(checkout) ?? buyer_id;
    const continueUrl = readContinueUrl(handoff);
    await rememberHandoffContext(handoff, connection);
    await saveLastCheckout({
      cart_id,
      store_id: effectiveStoreId,
      buyer_id: effectiveBuyerId,
      organization_id,
      language: language ?? config.language,
      checkout_id: checkoutId,
      continue_url: continueUrl,
      ucp_base_url: await getEffectiveBaseUrl(connection),
      storefront_url: await getEffectiveStorefrontUrl(continueUrl),
      updated_at: new Date().toISOString(),
    });

    return jsonResult({
      ok: true,
      cart_id,
      buyer_id: effectiveBuyerId,
      checkout,
      handoff,
      continue_url: continueUrl,
      mcp_context: await getPublicRuntimeContext(),
      next_step_after_payment: {
        tool: "track_order",
        arguments: {
          cart_id,
          buyer_id: effectiveBuyerId,
          language: language ?? config.language,
        },
      },
    });
  },
);

server.tool(
  "track_order",
  [
    "Track a Virto Commerce order through UCP after storefront handoff.",
    "Use order_id or order_number when the buyer already has an order identifier.",
    "Immediately after checkout handoff, use cart_id from the UCP cart/checkout plus buyer_id from the cart response.",
    "Do not inspect or reuse ucp_session for order tracking; expired handoff tokens are expected after checkout.",
    "If cart_id and buyer_id are available from checkout_and_handoff, call this tool directly instead of asking the buyer for an order number.",
    "The response includes order status, totals, line items, shipment snapshot, payment snapshot, and tracking fields when available.",
  ].join(" "),
  {
    ...connectionInput,
    order_id: z.string().optional().describe("Virto order id. If only an order number is known, pass order_number instead."),
    order_number: z.string().optional().describe("Virto order number."),
    cart_id: z.string().optional().describe("Original UCP cart id used for checkout handoff. If omitted, the MCP server will try the last saved checkout."),
    buyer_id: z.string().optional().describe("Buyer id from cart.buyer_id. If omitted with cart_id, the MCP server will try the last saved checkout."),
    organization_id: z.string().optional().describe("Buyer organization id for B2B order context."),
    language: z.string().optional().describe("Language/culture code. Defaults to UCP_LANGUAGE."),
  },
  async (input) => jsonResult(await trackOrder(input)),
);

server.tool(
  "track_last_order",
  [
    "Track the most recent checkout created by this MCP server.",
    "Use this when the buyer says they paid, completed checkout, or asks for order status after handoff.",
    "This tool reads the last saved cart_id and buyer_id; do not ask for order number/email first.",
  ].join(" "),
  {},
  async () => jsonResult(await trackOrder({})),
);

const transport = new StdioServerTransport();
await server.connect(transport);

async function ucpGet(path: string, connection: ConnectionInput = {}): Promise<unknown> {
  return ucpFetch(path, { method: "GET" }, connection);
}

async function ucpPost(path: string, body: unknown, connection: ConnectionInput = {}): Promise<unknown> {
  return ucpFetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }, connection);
}

async function ucpPatch(path: string, body: unknown, connection: ConnectionInput = {}): Promise<unknown> {
  return ucpFetch(path, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }, connection);
}

async function ucpPut(path: string, body: unknown, connection: ConnectionInput = {}): Promise<unknown> {
  return ucpFetch(path, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }, connection);
}

async function trackOrder(input: {
  order_id?: string;
  order_number?: string;
  cart_id?: string;
  buyer_id?: string;
  organization_id?: string;
  language?: string;
  base_url?: string;
  storefront_url?: string;
}): Promise<unknown> {
  const lastCheckout = await loadLastCheckout();
  const cartId = input.cart_id ?? lastCheckout?.cart_id;
  const buyerId = input.buyer_id ?? lastCheckout?.buyer_id;
  const organizationId = input.organization_id ?? lastCheckout?.organization_id;
  const language = input.language ?? lastCheckout?.language ?? config.language;
  const connection = {
    base_url: input.base_url ?? lastCheckout?.ucp_base_url,
    storefront_url: input.storefront_url ?? lastCheckout?.storefront_url,
  };

  const params = new URLSearchParams({
    culture_name: language,
  });

  appendOptional(params, "buyer_id", buyerId);
  appendOptional(params, "organization_id", organizationId);

  if (input.order_id) {
    return {
      lookup: {
        order_id: input.order_id,
        buyer_id: buyerId,
        organization_id: organizationId,
        language,
      },
      result: await ucpGet(`/ucp/v1/orders/${encodeURIComponent(input.order_id)}?${params}`, connection),
    };
  }

  if (input.order_number) {
    params.set("order_number", input.order_number);
    return {
      lookup: {
        order_number: input.order_number,
        buyer_id: buyerId,
        organization_id: organizationId,
        language,
      },
      result: await ucpGet(`/ucp/v1/orders?${params}`, connection),
    };
  }

  if (cartId) {
    params.set("cart_id", cartId);
    return {
      lookup: {
        cart_id: cartId,
        buyer_id: buyerId,
        organization_id: organizationId,
        language,
        source: input.cart_id ? "tool_arguments" : "last_saved_checkout",
      },
      result: await ucpGet(`/ucp/v1/orders?${params}`, connection),
    };
  }

  return {
    ok: false,
    error: "No order_id, order_number, cart_id, or saved checkout is available.",
    recovery_hint: "Create a new checkout through checkout_and_handoff, or call track_order with cart_id and buyer_id from the UCP cart response.",
    state_file: config.stateFile,
  };
}

async function discoverStoreContext(connection: ConnectionInput = {}): Promise<unknown> {
  await rememberConnectionInput(connection);
  const profile = await ucpGet("/.well-known/ucp", connection);
  await rememberProfileDiscovery(profile);

  return {
    profile,
    mcp_context: await getPublicRuntimeContext(),
  };
}

async function ensureStorefrontDiscovered(connection: ConnectionInput = {}): Promise<void> {
  await rememberConnectionInput(connection);

  if (config.storefrontUrl || connection.storefront_url) {
    const runtime = await loadRuntimeContext();
    if (runtime?.store_id || config.storeId) {
      return;
    }
  }

  const runtime = await loadRuntimeContext();
  if (runtime?.storefront_url && (runtime.store_id || config.storeId)) {
    return;
  }

  const profile = await ucpGet("/.well-known/ucp");
  await rememberProfileDiscovery(profile);
}

async function getEffectiveStoreId(storeId?: string, connection: ConnectionInput = {}): Promise<string | undefined> {
  if (storeId) {
    return storeId;
  }

  if (config.storeId) {
    return config.storeId;
  }

  const runtime = await loadRuntimeContext();
  if (runtime?.store_id) {
    return runtime.store_id;
  }

  await ensureStorefrontDiscovered(connection);
  return (await loadRuntimeContext())?.store_id;
}

async function rememberConnectionInput(connection: ConnectionInput = {}): Promise<void> {
  const update: Partial<RuntimeContextState> = {};

  if (connection.base_url) {
    update.ucp_base_url = trimTrailingSlash(connection.base_url);
  }

  if (connection.storefront_url) {
    update.storefront_url = trimTrailingSlash(connection.storefront_url);
    update.storefront_source = "tool_argument";
  } else if (config.storefrontUrl) {
    update.storefront_url = config.storefrontUrl;
    update.storefront_source = "env";
  }

  if (Object.keys(update).length > 0) {
    await saveRuntimeContext(update);
  }
}

async function rememberProfileDiscovery(profile: unknown): Promise<void> {
  if (isErrorResponse(profile)) {
    return;
  }

  const discovery = readStorefrontDiscovery(profile);
  if (!discovery.store_id && !discovery.storefront_url && !discovery.handoff_url_template) {
    return;
  }

  await saveRuntimeContext({
    store_id: config.storeId ?? discovery.store_id,
    store_source: config.storeId ? "env" : discovery.store_source,
    storefront_url: config.storefrontUrl ?? discovery.storefront_url,
    storefront_source: config.storefrontUrl ? "env" : discovery.storefront_source,
    handoff_url_template: discovery.handoff_url_template,
    profile_discovered_at: new Date().toISOString(),
  });
}

async function rememberHandoffContext(handoff: unknown, connection: ConnectionInput = {}): Promise<void> {
  const continueUrl = readContinueUrl(handoff);
  const storefrontFromContinueUrl = readOrigin(continueUrl);
  const runtime = await loadRuntimeContext();

  await saveRuntimeContext({
    ucp_base_url: await getEffectiveBaseUrl(connection),
    store_id: runtime?.store_id ?? config.storeId,
    storefront_url: connection.storefront_url ?? config.storefrontUrl ?? storefrontFromContinueUrl,
    storefront_source: connection.storefront_url
      ? "tool_argument"
      : config.storefrontUrl
        ? "env"
        : storefrontFromContinueUrl
          ? "handoff_response"
          : undefined,
  });
}

async function ucpFetch(path: string, init: RequestInit, connection: ConnectionInput = {}): Promise<unknown> {
  await rememberConnectionInput(connection);

  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");

  if (config.bearerToken) {
    headers.set("authorization", `Bearer ${config.bearerToken}`);
  }

  const baseUrl = await getEffectiveBaseUrl(connection);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      dispatcher,
    } as RequestInit & { dispatcher?: Agent });
  } catch (error) {
    return {
      ok: false,
      error: ucpError("invalid_request", `Unable to reach UCP base_url '${baseUrl}'.`, {
        base_url: baseUrl,
        path,
        cause: error instanceof Error ? error.message : String(error),
      }),
    };
  }

  const text = await response.text();
  const payload = parseJson(text);

  if (!response.ok) {
    const error = isUcpError(payload)
      ? payload
      : ucpError("invalid_request", `UCP request failed with HTTP ${response.status} ${response.statusText}.`, {
        base_url: baseUrl,
        path,
        status: response.status,
        status_text: response.statusText,
        body: text.slice(0, 1000),
      });

    return {
      ok: false,
      status: response.status,
      statusText: response.statusText,
      error,
    };
  }

  return payload ?? text;
}

function ucpError(code: string, message: string, details: JsonObject = {}): JsonObject {
  return {
    code,
    message,
    correlation_id: null,
    details,
  };
}

function isUcpError(value: unknown): value is JsonObject {
  return isRecord(value)
    && typeof value.code === "string"
    && typeof value.message === "string";
}

function cartBody(input: {
  line_items: Array<{ id?: string; product_id?: string; quantity: number }>;
  coupons?: string[];
  store_id?: string;
  currency?: string;
  language?: string;
  cart_name?: string;
  cart_type?: string;
  buyer_id?: string;
  organization_id?: string;
}): JsonObject {
  return {
    context: {
      store_id: input.store_id ?? config.storeId,
      currency: input.currency ?? config.currency,
      language: input.language ?? config.language,
      cart_name: input.cart_name,
      cart_type: input.cart_type,
      buyer_id: input.buyer_id,
      organization_id: input.organization_id,
    },
    line_items: input.line_items,
    coupons: input.coupons ?? [],
  };
}

function checkoutBody(input: {
  cart_id: string;
  store_id?: string;
  currency?: string;
  language?: string;
  buyer_id?: string;
  organization_id?: string;
  buyer_email?: string;
  buyer_name?: string;
  buyer_phone?: string;
  shipping_address?: JsonObject;
  billing_address?: JsonObject;
  payment_handler?: string;
  notes?: string;
}): JsonObject {
  return {
    cart_id: input.cart_id,
    context: {
      store_id: input.store_id ?? config.storeId,
      currency: input.currency ?? config.currency,
      language: input.language ?? config.language,
      buyer_id: input.buyer_id,
      organization_id: input.organization_id,
    },
    buyer: {
      id: input.buyer_id,
      email: input.buyer_email,
      name: input.buyer_name,
      phone: input.buyer_phone,
    },
    shipping_address: input.shipping_address,
    billing_address: input.billing_address ?? input.shipping_address,
    payment_handler: input.payment_handler,
    notes: input.notes,
  };
}

function appendOptional(params: URLSearchParams, name: string, value?: string): void {
  if (value) {
    params.set(name, value);
  }
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function parseJson(text: string): unknown {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function saveLastCheckout(state: LastCheckoutState): Promise<void> {
  await mkdir(dirname(config.stateFile), { recursive: true });
  await writeFile(config.stateFile, JSON.stringify(state, null, 2), "utf8");
}

async function loadLastCheckout(): Promise<LastCheckoutState | undefined> {
  try {
    const text = await readFile(config.stateFile, "utf8");
    const value = JSON.parse(text) as Partial<LastCheckoutState>;
    return typeof value.cart_id === "string"
      ? {
          cart_id: value.cart_id,
          store_id: typeof value.store_id === "string" ? value.store_id : undefined,
          buyer_id: typeof value.buyer_id === "string" ? value.buyer_id : undefined,
          organization_id: typeof value.organization_id === "string" ? value.organization_id : undefined,
          language: typeof value.language === "string" ? value.language : undefined,
          checkout_id: typeof value.checkout_id === "string" ? value.checkout_id : undefined,
          continue_url: typeof value.continue_url === "string" ? value.continue_url : undefined,
          ucp_base_url: typeof value.ucp_base_url === "string" ? value.ucp_base_url : undefined,
          storefront_url: typeof value.storefront_url === "string" ? value.storefront_url : undefined,
          updated_at: typeof value.updated_at === "string" ? value.updated_at : new Date(0).toISOString(),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

async function loadRuntimeContext(): Promise<RuntimeContextState | undefined> {
  if (runtimeContextCache) {
    return runtimeContextCache;
  }

  try {
    const text = await readFile(config.contextFile, "utf8");
    const value = JSON.parse(text) as Partial<RuntimeContextState>;
    if (typeof value.ucp_base_url !== "string") {
      return undefined;
    }

    runtimeContextCache = {
      ucp_base_url: value.ucp_base_url,
      store_id: typeof value.store_id === "string" ? value.store_id : undefined,
      store_source: typeof value.store_source === "string" ? value.store_source : undefined,
      storefront_url: typeof value.storefront_url === "string" ? value.storefront_url : undefined,
      storefront_source: typeof value.storefront_source === "string" ? value.storefront_source : undefined,
      handoff_url_template: typeof value.handoff_url_template === "string" ? value.handoff_url_template : undefined,
      profile_discovered_at: typeof value.profile_discovered_at === "string" ? value.profile_discovered_at : undefined,
      updated_at: typeof value.updated_at === "string" ? value.updated_at : new Date(0).toISOString(),
    };

    return runtimeContextCache;
  } catch {
    return undefined;
  }
}

async function saveRuntimeContext(update: Partial<RuntimeContextState>): Promise<RuntimeContextState> {
  const current = await loadRuntimeContext();
  const next: RuntimeContextState = {
    ucp_base_url: update.ucp_base_url ?? current?.ucp_base_url ?? config.baseUrl,
    store_id: update.store_id ?? current?.store_id,
    store_source: update.store_source ?? current?.store_source,
    storefront_url: update.storefront_url ?? current?.storefront_url,
    storefront_source: update.storefront_source ?? current?.storefront_source,
    handoff_url_template: update.handoff_url_template ?? current?.handoff_url_template,
    profile_discovered_at: update.profile_discovered_at ?? current?.profile_discovered_at,
    updated_at: new Date().toISOString(),
  };

  runtimeContextCache = next;
  await mkdir(dirname(config.contextFile), { recursive: true });
  await writeFile(config.contextFile, JSON.stringify(next, null, 2), "utf8");
  return next;
}

async function getEffectiveBaseUrl(connection: ConnectionInput = {}): Promise<string> {
  if (connection.base_url) {
    return trimTrailingSlash(connection.base_url);
  }

  if (config.hasExplicitBaseUrl) {
    return config.baseUrl;
  }

  const runtime = await loadRuntimeContext();
  return runtime?.ucp_base_url ?? config.baseUrl;
}

async function getEffectiveStorefrontUrl(continueUrl?: string): Promise<string | undefined> {
  if (config.storefrontUrl) {
    return config.storefrontUrl;
  }

  const fromContinueUrl = readOrigin(continueUrl);
  if (fromContinueUrl) {
    return fromContinueUrl;
  }

  const runtime = await loadRuntimeContext();
  return runtime?.storefront_url;
}

async function getPublicRuntimeContext(): Promise<JsonObject> {
  const runtime = await loadRuntimeContext();

  return {
    ucp_base_url: runtime?.ucp_base_url ?? config.baseUrl,
    store_id: config.storeId ?? runtime?.store_id,
    store_source: config.storeId ? "env" : runtime?.store_source,
    storefront_url: config.storefrontUrl ?? runtime?.storefront_url,
    storefront_source: config.storefrontUrl ? "env" : runtime?.storefront_source,
    handoff_url_template: runtime?.handoff_url_template,
    state_file: config.stateFile,
    context_file: config.contextFile,
  };
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeOptionalUrl(value?: string): string | undefined {
  return value ? trimTrailingSlash(value) : undefined;
}

function isErrorResponse(value: unknown): boolean {
  return isRecord(value) && value.ok === false;
}

function readCheckoutId(value: unknown): string | undefined {
  const checkout = isRecord(value) && isRecord(value.checkout) ? value.checkout : undefined;
  return typeof checkout?.id === "string" ? checkout.id : undefined;
}

function readContinueUrl(value: unknown): string | undefined {
  const checkout = isRecord(value) && isRecord(value.checkout) ? value.checkout : undefined;
  return typeof checkout?.continue_url === "string" ? checkout.continue_url : undefined;
}

function readStorefrontDiscovery(value: unknown): StorefrontDiscovery {
  const profile = isRecord(value) ? value : undefined;
  const endpoints = isRecord(profile?.endpoints) ? profile.endpoints : undefined;
  const storefront = isRecord(profile?.storefront) ? profile.storefront : undefined;
  const store = isRecord(profile?.store) ? profile.store : undefined;
  const stores = Array.isArray(profile?.stores) ? profile.stores.filter(isRecord) : [];
  const handoffTemplate = firstString(endpoints?.handoff_url_template, endpoints?.handoffUrlTemplate);
  const onlyStore = stores.length === 1 ? stores[0] : undefined;
  const storeId = firstString(
    profile?.default_store_id,
    profile?.defaultStoreId,
    store?.id,
    stores.find(x => x.is_default === true || x.isDefault === true)?.id,
    onlyStore?.id,
  );
  const storefrontUrl = firstUrl(
    firstString(store?.secure_url, store?.secureUrl),
    firstString(store?.url),
    typeof storefront?.url === "string" ? storefront.url : undefined,
    firstString(profile?.storefront_origin, profile?.storefrontOrigin),
    readOrigin(handoffTemplate),
  );

  return {
    store_id: storeId,
    store_source: storeId ? "ucp_discovery" : undefined,
    storefront_url: storefrontUrl,
    storefront_source: typeof storefront?.source === "string" ? storefront.source : storefrontUrl ? "ucp_discovery" : undefined,
    handoff_url_template: handoffTemplate,
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return undefined;
}

function firstUrl(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (!value) {
      continue;
    }

    try {
      return trimTrailingSlash(new URL(value).origin);
    } catch {
      continue;
    }
  }

  return undefined;
}

function readOrigin(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return trimTrailingSlash(new URL(value).origin);
  } catch {
    return undefined;
  }
}

function readBuyerId(value: unknown): string | undefined {
  const checkout = isRecord(value) && isRecord(value.checkout) ? value.checkout : undefined;
  const cart = isRecord(checkout?.cart) ? checkout.cart : undefined;
  return typeof cart?.buyer_id === "string" ? cart.buyer_id : undefined;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
