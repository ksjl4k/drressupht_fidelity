// DressupHT company portal - customer lookup by DressupHT Member ID.
//
// This page signs the employee in with Supabase Auth (email + password) and
// keeps that session. It deliberately reads nothing from the database: the
// customers table, the loyalty ledger and company_staff are server-side only.
//
// Every customer read therefore goes through the company-customer-lookup Edge
// Function, which is deployed with --no-verify-jwt and authenticates the
// caller itself from the access token sent below. The browser sends its own
// session token and nothing else; it holds no service-role credential, it makes
// no authorization decision, and no customer data is written to storage.
const supabaseClient = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

const LOOKUP_URL = `${CONFIG.SUPABASE_URL}/functions/v1/company-customer-lookup`;

// Fixed French messages, one per outcome, so nothing the server says is
// reflected into the page.
const LOOKUP_MESSAGES = {
  empty: "Veuillez saisir un ID membre DressupHT.",
  invalid: "ID membre invalide : v\u00e9rifiez la saisie.",
  unauthorized: "Session expir\u00e9e ou invalide : reconnectez-vous.",
  forbidden: "Acc\u00e8s refus\u00e9 : ce compte n'est pas un employ\u00e9 DressupHT actif.",
  notFound: "Aucun membre trouv\u00e9 pour cet ID.",
  server: "Erreur du serveur : le service est indisponible pour le moment.",
  offline: "Connexion impossible : v\u00e9rifiez votre r\u00e9seau.",
};

document.addEventListener("DOMContentLoaded", () => {
  const loginView = document.getElementById("login-view");
  const portalView = document.getElementById("portal-view");
  const loginForm = document.getElementById("login-form");
  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const loginButton = document.getElementById("login-button");
  const loadingIndicator = document.getElementById("loading-indicator");
  const errorMessage = document.getElementById("error-message");
  const userEmail = document.getElementById("user-email");
  const logoutButton = document.getElementById("logout-button");
  const accountBar = document.getElementById("account-bar");

  const lookupForm = document.getElementById("lookup-form");
  const memberIdInput = document.getElementById("member-id");
  const lookupButton = document.getElementById("lookup-button");
  const lookupError = document.getElementById("lookup-error");
  const lookupLoading = document.getElementById("lookup-loading");

  const resultCard = document.getElementById("result-card");
  const resultName = document.getElementById("result-name");
  const resultMemberId = document.getElementById("result-member-id");
  const resultBadge = document.getElementById("result-badge");
  const resultEmail = document.getElementById("result-email");
  const resultPhone = document.getElementById("result-phone");
  const resultBirthday = document.getElementById("result-birthday");
  const resultSquareId = document.getElementById("result-square-id");
  const loyaltyBalance = document.getElementById("loyalty-balance");
  const loyaltyEligible = document.getElementById("loyalty-eligible");
  const loyaltyAwarded = document.getElementById("loyalty-awarded");
  const loyaltyDeducted = document.getElementById("loyalty-deducted");
  const loyaltyTransactions = document.getElementById("loyalty-transactions");
  const loyaltyRate = document.getElementById("loyalty-rate");
  const loyaltyLastActivity = document.getElementById("loyalty-last-activity");
  const loyaltyStatus = document.getElementById("loyalty-status");

  const startScannerButton = document.getElementById("start-scanner");
  const stopScannerButton = document.getElementById("stop-scanner");
  const scannerPreview = document.getElementById("scanner-preview");
  const scannerVideo = document.getElementById("scanner-video");
  const scannerStatus = document.getElementById("scanner-status");

  const showError = (text) => {
    errorMessage.textContent = text;
    errorMessage.hidden = !text;
  };

  const setLoading = (isLoading) => {
    loginButton.disabled = isLoading;
    loginButton.textContent = isLoading ? "Connexion\u2026" : "Se connecter";
    loadingIndicator.hidden = !isLoading;
  };

  const showLookupError = (text) => {
    lookupError.textContent = text;
    lookupError.hidden = !text;
  };

  const setLookupLoading = (isLoading) => {
    lookupButton.disabled = isLoading;
    lookupButton.textContent = isLoading ? "Recherche\u2026" : "Rechercher";
    lookupLoading.hidden = !isLoading;
    memberIdInput.disabled = isLoading;
  };

  // The previous customer is always dropped before a new lookup, so a stale
  // card can never be read as the result of a fresh search.
  const clearResult = () => {
    resultCard.hidden = true;
    resultName.textContent = "";
    resultMemberId.textContent = "";
    resultBadge.textContent = "";
    resultEmail.textContent = "";
    resultPhone.textContent = "";
    resultBirthday.textContent = "";
    resultSquareId.textContent = "";
    loyaltyBalance.textContent = "";
    loyaltyEligible.textContent = "";
    loyaltyAwarded.textContent = "";
    loyaltyDeducted.textContent = "";
    loyaltyTransactions.textContent = "";
    loyaltyRate.textContent = "";
    loyaltyLastActivity.textContent = "";
    loyaltyStatus.textContent = "";
  };

  const showLogin = (message) => {
    showError(message || "");
    stopScanner();
    setLoading(false);
    clearResult();
    setLookupLoading(false);
    showLookupError("");
    memberIdInput.value = "";
    userEmail.textContent = "";
    accountBar.hidden = true;
    document.body.classList.remove("portal-mode");
    portalView.hidden = true;
    loginView.hidden = false;
  };

  const showPortal = (email) => {
    setLoading(false);
    showError("");
    userEmail.textContent = email || "";
    accountBar.hidden = false;
    document.body.classList.add("portal-mode");
    loginView.hidden = true;
    portalView.hidden = false;
  };

  // --- display helpers ---------------------------------------------------

  const EMPTY = "\u2014";

  const text = (value) => {
    if (value === null || value === undefined) return EMPTY;
    const trimmed = String(value).trim();
    return trimmed ? trimmed : EMPTY;
  };

  const formatNumber = (value) =>
    typeof value === "number" && Number.isFinite(value)
      ? value.toLocaleString("fr-FR")
      : EMPTY;

  const formatDate = (value) => {
    if (typeof value !== "string" || !value.trim()) return EMPTY;
    const raw = value.trim();
    // A date-only value is a calendar date, not an instant. Building it from
    // the year, month and day keeps it on the intended day in every timezone,
    // instead of shifting to the previous day west of UTC.
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    const parsed = dateOnly
      ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
      : new Date(raw);
    if (Number.isNaN(parsed.getTime())) return EMPTY;
    return parsed.toLocaleDateString("fr-FR");
  };

  const fullName = (customer) => {
    const first = text(customer.first_name);
    const last = text(customer.last_name);
    if (first === EMPTY && last === EMPTY) return "Membre sans nom";
    return `${first === EMPTY ? "" : first} ${last === EMPTY ? "" : last}`.trim();
  };

  // Every value is written with textContent, so a customer record can never
  // inject markup into the page.
  const renderResult = (customer, loyalty) => {
    const name = fullName(customer);

    resultName.textContent = name;
    resultMemberId.textContent = `ID membre : ${text(customer.dressup_member_id)}`;
    resultEmail.textContent = text(customer.email);
    resultPhone.textContent = text(customer.phone);
    resultBirthday.textContent = formatDate(customer.birthday);
    resultSquareId.textContent = text(customer.square_customer_id);

    const status = text(loyalty.status);
    resultBadge.textContent = status;
    const badgeStatus = status
      .toLowerCase()
      .replace(/[^a-z]+/g, "-")
      .replace(/^-+|-+$/g, "");
    resultBadge.className = badgeStatus ? `badge badge-${badgeStatus}` : "badge";

    loyaltyBalance.textContent = formatNumber(loyalty.points_balance);
    loyaltyEligible.textContent = formatNumber(loyalty.eligible_points);
    loyaltyAwarded.textContent = formatNumber(loyalty.lifetime_awarded);
    loyaltyDeducted.textContent = formatNumber(loyalty.lifetime_deducted);
    loyaltyTransactions.textContent = formatNumber(loyalty.transactions_count);
    loyaltyRate.textContent = formatNumber(loyalty.exchange_rate);
    loyaltyLastActivity.textContent = formatDate(loyalty.last_activity_at);
    loyaltyStatus.textContent = status;

    resultCard.hidden = false;
  };

  // --- session -----------------------------------------------------------

  // The access token comes from the live Supabase session on every call, so a
  // refreshed or expired session is never masked by a cached value.
  const getAccessToken = async () => {
    const { data, error } = await supabaseClient.auth.getSession();

    if (error || !data.session) {
      return null;
    }

    return data.session.access_token || null;
  };

  // A session left in local storage by a previous visit survives a refresh.
  supabaseClient.auth.getSession().then(({ data }) => {
    if (data.session) {
      showPortal(data.session.user.email);
    } else {
      showLogin();
    }
  });

  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT" || !session) {
      showLogin();
    } else {
      showPortal(session.user.email);
    }
  });

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    showError("");
    setLoading(true);

    const { error } = await supabaseClient.auth.signInWithPassword({
      email: emailInput.value.trim(),
      password: passwordInput.value,
    });

    setLoading(false);

    if (error) {
      showError(
        error.message === "Invalid login credentials"
          ? "Email ou mot de passe incorrect."
          : error.message
      );
      return;
    }

    passwordInput.value = "";
  });

  logoutButton.addEventListener("click", async () => {
    await supabaseClient.auth.signOut();
    showLogin();
  });

  // --- lookup ------------------------------------------------------------

  // Both the manual form and the QR scanner go through this one function, so
  // the request contract and the rendering are always identical. It resolves
  // with an outcome for the caller, but the manual form only cares about the
  // on-screen result.
  const performLookup = async (memberId) => {
    // Always start from a clean slate: no previous card, no previous error.
    clearResult();
    showLookupError("");

    if (!memberId) {
      showLookupError(LOOKUP_MESSAGES.empty);
      memberIdInput.focus();
      return "empty";
    }

    const accessToken = await getAccessToken();

    if (!accessToken) {
      showLogin(LOOKUP_MESSAGES.unauthorized);
      return "unauthorized";
    }

    setLookupLoading(true);

    try {
      const response = await fetch(LOOKUP_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ member_id: memberId }),
      });

      if (response.status === 200) {
        const payload = await response.json();

        if (!payload || !payload.customer || !payload.loyalty) {
          showLookupError(LOOKUP_MESSAGES.server);
          return "server";
        }

        renderResult(payload.customer, payload.loyalty);
        return "found";
      }

      if (response.status === 400) {
        showLookupError(LOOKUP_MESSAGES.invalid);
        return "invalid";
      }

      if (response.status === 401) {
        // The session is no longer accepted: back to the login screen.
        showLogin(LOOKUP_MESSAGES.unauthorized);
        return "unauthorized";
      }

      if (response.status === 403) {
        showLookupError(LOOKUP_MESSAGES.forbidden);
        return "forbidden";
      }

      if (response.status === 404) {
        showLookupError(LOOKUP_MESSAGES.notFound);
        return "not_found";
      }

      showLookupError(LOOKUP_MESSAGES.server);
      return "server";
    } catch {
      showLookupError(LOOKUP_MESSAGES.offline);
      return "offline";
    } finally {
      setLookupLoading(false);
    }
  };

  // Submitting the form covers both the button and the Enter key.
  lookupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    performLookup(memberIdInput.value.trim());
  });

  // --- QR scanner --------------------------------------------------------
  // The QR code only carries the customer's DressupHT member ID (e.g.
  // "john-123456"). The camera is an input device and nothing more: its output
  // is treated as untrusted text, validated like the manual field, then sent
  // through performLookup() above, which re-reads the live session token on
  // every call. The authenticated Edge Function + company_staff check remain
  // the only authorization boundary; nothing from the QR is ever trusted for
  // access.

  const SCANNER_MESSAGES = {
    ready: "Cam\u00e9ra non d\u00e9marr\u00e9e.",
    starting: "Demande d'acc\u00e8s \u00e0 la cam\u00e9ra\u2026",
    scanning: "En attente d'un QR code\u2026",
    detected: "QR d\u00e9tect\u00e9 : recherche en cours\u2026",
    invalid: "QR illisible : le code ne contient pas un ID membre DressupHT valide.",
    unavailable: "Scanner indisponible dans ce navigateur : utilisez la recherche manuelle.",
    noCamera: "Aucune cam\u00e9ra disponible sur cet appareil.",
    permissionDenied: "Acc\u00e8s cam\u00e9ra refus\u00e9 : autorisez la cam\u00e9ra, puis r\u00e9essayez.",
    cameraError: "Impossible de d\u00e9marrer la cam\u00e9ra.",
    found: "Membre trouv\u00e9.",
    notFound: "Aucun membre trouv\u00e9 pour ce QR code.",
    forbidden: "Acc\u00e8s refus\u00e9 par le serveur.",
    server: LOOKUP_MESSAGES.server,
    offline: LOOKUP_MESSAGES.offline,
  };

  const SCANNER_STATUS_CLASSES = ["is-active", "is-error", "is-success"];

  const setScannerStatus = (key) => {
    scannerStatus.textContent = SCANNER_MESSAGES[key] || "";
    for (const stateClass of SCANNER_STATUS_CLASSES) scannerStatus.classList.remove(stateClass);
    if (key === "starting" || key === "scanning" || key === "detected") {
      scannerStatus.classList.add("is-active");
    } else if (key === "unavailable" || key === "noCamera" || key === "permissionDenied" || key === "cameraError" || key === "invalid" || key === "server" || key === "offline") {
      scannerStatus.classList.add("is-error");
    } else if (key === "found") {
      scannerStatus.classList.add("is-success");
    }
  };

  const setScannerButtons = (scanning) => {
    startScannerButton.hidden = scanning;
    stopScannerButton.hidden = !scanning;
  };

  let qrScanner = null;
  let cameraOn = false;

  const ensureScanner = () => {
    if (!qrScanner) {
      qrScanner = new QrScanner(scannerVideo, onQrDecoded, {
        returnDetailedScanResult: true,
      });
    }
    return qrScanner;
  };

  // Releases the camera and the video stream. Called on every end of scanning:
  // after a successful or rejected read, on the stop button, on an error, and
  // whenever the employee returns to the login screen (showLogin).
  const stopScanner = () => {
    if (qrScanner) {
      try {
        qrScanner.stop();
      } catch {
        // Already released by the browser; nothing else to do.
      }
    }
    cameraOn = false;
    scannerPreview.hidden = true;
    scannerVideo.srcObject = null;
    setScannerButtons(false);
  };

  // Member IDs are generated on the signup form as "firstname-6digits" (e.g.
  // jean-482910) and only ever contain letters, digits and a hyphen. This
  // check stays deliberately lenient on that shape but rejects content that
  // can never be a member ID (a URL, an email, spaces), before any request.
  const sanitizeScannedId = (raw) => {
    if (typeof raw !== "string") return null;
    const id = raw.trim();
    if (!id || id.length > 128) return null;
    if (/[^A-Za-z0-9-]/.test(id)) return null;
    return id;
  };

  const scanOutcomeStatus = (outcome) => {
    if (outcome === "found") return "found";
    if (outcome === "not_found") return "notFound";
    if (outcome === "invalid") return "invalid";
    if (outcome === "forbidden") return "forbidden";
    if (outcome === "server") return "server";
    if (outcome === "offline") return "offline";
    return null; // "unauthorized" already sent the employee back to login
  };

  const onQrDecoded = async (raw) => {
    // The camera is released immediately, before the value is even inspected,
    // so no stream is left running in the background.
    stopScanner();

    const payload = typeof raw === "string" ? raw : raw ? raw.data : "";
    const memberId = sanitizeScannedId(payload);

    if (!memberId) {
      setScannerStatus("invalid");
      return;
    }

    setScannerStatus("detected");
    const outcome = await performLookup(memberId);
    const statusKey = scanOutcomeStatus(outcome);
    if (statusKey) setScannerStatus(statusKey);
  };

  startScannerButton.addEventListener("click", async () => {
    if (cameraOn) return;

    clearResult();
    showLookupError("");
    setScannerStatus("starting");
    setScannerButtons(true);
    scannerPreview.hidden = false;

    if (typeof QrScanner === "undefined") {
      setScannerStatus("unavailable");
      stopScanner();
      return;
    }

    try {
      const hasCamera = await QrScanner.hasCamera();
      if (hasCamera === false) {
        setScannerStatus("noCamera");
        stopScanner();
        return;
      }
    } catch {
      // hasCamera may fail on odd devices; start() below reports the real
      // permission and camera errors.
    }

    try {
      const scanner = ensureScanner();
      await scanner.start();
      cameraOn = true;
      setScannerStatus("scanning");
    } catch (err) {
      const name = err && err.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        setScannerStatus("permissionDenied");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setScannerStatus("noCamera");
      } else {
        setScannerStatus("cameraError");
      }
      stopScanner();
    }
  });

  stopScannerButton.addEventListener("click", () => {
    stopScanner();
    setScannerStatus("ready");
  });

  // Safety net if the page is torn down while the camera is running. The
  // browser would release the stream by itself, but stopping explicitly is
  // cleaner and avoids a blinking light on some devices.
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", () => stopScanner());
  }

  // Initial scanner state; the ready message is set here so the "Ready to
  // scan" label is deterministic regardless of how the HTML was served.
  setScannerStatus("ready");
});
