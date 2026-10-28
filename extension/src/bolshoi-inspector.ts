/** Serialized into the active tab. Reads structure only; never reads input values or clicks. */
export function inspectBolshoiPage() {
  const host = location.hostname;
  if (location.protocol !== "https:" || (location.port && location.port !== "443") ||
      !["ticket.bolshoi.ru", "bolshoi.ru"].includes(host)) {
    return {ok: false as const, message: "Откройте официальный сайт bolshoi.ru или ticket.bolshoi.ru."};
  }
  const route = (pathname: string) => {
    if (/^\/login\/?$/.test(pathname)) return "login";
    if (/^\/shows\/?$/.test(pathname)) return "shows";
    if (/^\/show\/[^/]+\/?$/.test(pathname)) return "show";
    if (/^\/(?:cart|basket|checkout|order)(?:\/|$)/.test(pathname)) return "checkout";
    if (/^\/(?:profile|account|personal)(?:\/|$)/.test(pathname)) return "account";
    return "unknown";
  };
  const visible = (node: Element) => {
    const style = getComputedStyle(node);
    return node.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
  };
  const classify = (node: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
    // Raw labels, name/id/placeholder and autocomplete are discarded after classification.
    const hint = [node.getAttribute("autocomplete") ?? "", node.name, node.id,
      node.getAttribute("placeholder") ?? "", node.getAttribute("aria-label") ?? "",
      ...[...(node.labels ?? [])].map(label => label.textContent ?? "")]
      .join(" ").toLowerCase().replace(/[_-]/g, " ").slice(0, 4000);
    const terms: [string, RegExp][] = [
      ["password", /password|парол/],
      ["verification_code", /one time code|код подтверждения|код из/],
      ["email", /e mail|email|электронн.*почт/],
      ["phone", /телефон|phone|(?:^|\s)tel(?:\s|$)/],
      ["document_expiry", /срок.*действ|действ.*до|expir/],
      ["document_type", /тип.*документ|вид.*документ|document type/],
      ["document_series", /сери[яи]|series/],
      ["document_number", /паспорт|passport|номер.*документ|document number/],
      ["birth_date", /дата.*рожден|birth|bday/],
      ["middle_name", /отчеств|middle name|additional name/],
      ["last_name", /фамили|last name|family name|surname/],
      ["first_name", /(?:^|\s)имя(?:\s|$)|first name|given name/],
      ["citizenship", /гражданств|citizenship|nationality/]
    ];
    const matches = terms.filter(([, pattern]) => pattern.test(hint)).map(([name]) => name);
    return matches.length === 1 ? matches[0]! : "unknown";
  };
  const nodes = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input,select,textarea")]
    .filter(node => !(node instanceof HTMLInputElement && node.type === "hidden") && visible(node));
  const controls = nodes.slice(0, 200).map((node, index) => ({
    index: index + 1,
    tag: node.tagName.toLowerCase(),
    type: node instanceof HTMLInputElement ? node.type : node.tagName.toLowerCase(),
    fieldHint: classify(node),
    required: node.required,
    disabled: node.disabled,
    maxLength: node instanceof HTMLSelectElement ? null : (node.maxLength >= 0 && node.maxLength <= 4096 ? node.maxLength : null)
  }));
  const actionTerms: Record<string, RegExp> = {
    login: /^(?:войти|вход|авторизоваться|sign in|log in)$/i,
    add_to_cart: /^(?:в корзину|добавить в корзину|add to cart)$/i,
    next: /^(?:далее|продолжить|next|continue)$/i,
    payment: /^(?:оплатить|перейти к оплате|pay|pay now)$/i,
    submit_order: /^(?:оформить заказ|подтвердить заказ)$/i
  };
  const actions = new Set<string>();
  for (const node of [...document.querySelectorAll("button,a,[role=button],input[type=submit]")].filter(visible).slice(0, 500)) {
    // input.value is deliberately never read, including for submit buttons.
    const label = (node.getAttribute("aria-label") ?? node.textContent ?? "").trim().slice(0, 100);
    for (const [name, pattern] of Object.entries(actionTerms)) if (pattern.test(label)) actions.add(name);
  }
  const frames = [...document.querySelectorAll("iframe")];
  const captchaPresent = frames.some(frame => {
    try {
      const src = new URL(frame.getAttribute("src") ?? "", location.origin);
      return ["www.google.com", "www.recaptcha.net", "hcaptcha.com", "newassets.hcaptcha.com"].includes(src.hostname) && /captcha/i.test(src.pathname);
    } catch {return false;}
  });
  // Inventory geometry and public seat-like metadata. No arbitrary attributes, HTML or text.
  const finite = (value: number) => Number.isFinite(value) && Math.abs(value) <= 10_000_000;
  const rounded = (value: number) => Math.round(value * 10) / 10;
  const box = (node: Element) => {
    const rect = node.getBoundingClientRect();
    if (![rect.x, rect.y, rect.width, rect.height].every(finite)) return null;
    return {x: rounded(rect.x + scrollX), y: rounded(rect.y + scrollY), width: rounded(rect.width), height: rounded(rect.height)};
  };
  const color = (value: string) => /^(?:none|transparent|currentcolor|#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|[a-z]{1,20})$/i.test(value) && value.length <= 80 ? value : null;
  const numericAttribute = (node: Element, names: string[], max: number) => {
    for (const name of names) {
      const value = node.getAttribute(name);
      if (value !== null && /^\d{1,8}(?:[.,]\d{1,2})?$/.test(value)) {
        const number = Number(value.replace(",", "."));
        if (number >= 0 && number <= max) return number;
      }
    }
    return null;
  };
  const publicFlags = new Set(["seat", "place", "available", "unavailable", "free", "occupied", "disabled", "selected", "reserved", "passport", "blocked", "seat-free", "seat-available", "seat-selected", "seat-occupied", "seat-disabled"]);
  const attributes = ["role", "tabindex", "aria-disabled", "aria-selected", "data-seat", "data-seat-id", "data-place", "data-place-id", "data-row", "data-price", "data-status", "data-state", "data-sector", "data-area"];
  const metadata = (node: Element) => {
    const flags = new Set<string>();
    const present = new Set<string>();
    let row: number | null = null, seat: number | null = null, price: number | null = null;
    let state: string | null = null;
    let element: Element | null = node;
    for (let depth = 0; element && depth < 3; depth++, element = element.parentElement) {
      for (const name of attributes) if (element.hasAttribute(name)) present.add(name);
      for (const token of [...element.classList].slice(0, 100)) {
        const normalized = token.toLowerCase();
        if (publicFlags.has(normalized)) flags.add(normalized);
      }
      row ??= numericAttribute(element, ["data-row"], 9999);
      seat ??= numericAttribute(element, ["data-seat", "data-place"], 9999);
      price ??= numericAttribute(element, ["data-price"], 1_000_000);
      const declared = element.getAttribute("data-status") ?? element.getAttribute("data-state");
      if (!state && declared && ["available", "unavailable", "free", "occupied", "disabled", "selected", "reserved", "blocked"].includes(declared)) state = declared;
    }
    return {attributeNames: [...present].sort(), classHints: [...flags].sort(), row, seat, price, declaredState: state};
  };
  const svgs = [...document.querySelectorAll("svg")].filter(visible);
  const surfaces = svgs.slice(0, 20).map((svg, index) => {
    const bounds = box(svg);
    const shapes = svg.querySelectorAll("rect,circle,ellipse,path,polygon,use").length;
    return {index: index + 1, bounds, shapeCount: shapes, mapCandidate: !!bounds && bounds.width >= 150 && bounds.height >= 100 && shapes >= 20};
  });
  const shapeSelector = "rect,circle,ellipse,path,polygon,use,div,span,a,button,[role=button],[role=checkbox],[role=option],[data-seat],[data-place],[data-seat-id],[data-place-id]";
  const scanned = [...document.querySelectorAll(shapeSelector)];
  const small: {node: Element; bounds: NonNullable<ReturnType<typeof box>>; bucket: string}[] = [];
  const frequencies = new Map<string, number>();
  for (const node of scanned.slice(0, 20_000)) {
    const bounds = box(node);
    if (!bounds || bounds.width < 3 || bounds.height < 3 || bounds.width > 45 || bounds.height > 45 || !visible(node)) continue;
    const bucket = `${Math.round(bounds.width / 2)}:${Math.round(bounds.height / 2)}`;
    frequencies.set(bucket, (frequencies.get(bucket) ?? 0) + 1);
    small.push({node, bounds, bucket});
  }
  const repeated = small.filter(item => (frequencies.get(item.bucket) ?? 0) >= 20);
  // If SVG <g> and its child shape share bounds, keep the leaf shape only.
  const unique = new Set<string>();
  const candidates = repeated.filter(({node, bounds}) => {
    if (node.tagName.toLowerCase() === "g") return false;
    const signature = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
    if (unique.has(signature)) return false;
    unique.add(signature);
    return true;
  });
  const seatCandidates = candidates.slice(0, 1500).map(({node, bounds}, index) => {
    const style = getComputedStyle(node);
    const svg = node.closest("svg");
    return {
      index: index + 1,
      tag: node.tagName.toLowerCase(),
      svgIndex: svg ? svgs.indexOf(svg as SVGSVGElement) + 1 : null,
      bounds,
      style: {fill: color(style.fill), stroke: color(style.stroke), background: color(style.backgroundColor), border: color(style.borderColor), pointerCursor: style.cursor === "pointer"},
      metadata: metadata(node)
    };
  });
  const mapStructure = {
    svgSurfaces: surfaces,
    svgSurfacesTruncated: svgs.length > 20,
    scannedElementsTruncated: scanned.length > 20_000,
    candidateCount: candidates.length,
    candidatesTruncated: candidates.length > 1500,
    seatCandidates,
    detection: "repeated_small_shapes_only",
    geometrySpace: "document_css_pixels",
    availabilityVerified: false,
    seatIdentityVerified: false
  };

  return {
    ok: true as const,
    report: {
      format: "purchase-assistant-bolshoi-discovery",
      version: 2,
      host,
      routeKind: route(location.pathname),
      // Only structural information; not a selector contract or proof of authentication/hold.
      controls,
      controlsTruncated: nodes.length > 200,
      recognizedActions: [...actions].sort(),
      frameCount: frames.length,
      captchaFrameDetected: captchaPresent,
      visibleCanvasCount: [...document.querySelectorAll("canvas")].filter(visible).length,
      visibleSvgCount: svgs.length,
      mapStructure,
      scope: "top_document_only",
      fieldHintsAreAuthoritative: false,
      reservationVerified: false
    }
  };
}
