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

  // Submitting the form covers both the button and the Enter key.
  lookupForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const memberId = memberIdInput.value.trim();

    // Always start from a clean slate: no previous card, no previous error.
    clearResult();
    showLookupError("");

    if (!memberId) {
      showLookupError(LOOKUP_MESSAGES.empty);
      memberIdInput.focus();
      return;
    }

    const accessToken = await getAccessToken();

    if (!accessToken) {
      showLogin(LOOKUP_MESSAGES.unauthorized);
      return;
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
          return;
        }

        renderResult(payload.customer, payload.loyalty);
        return;
      }

      if (response.status === 400) {
        showLookupError(LOOKUP_MESSAGES.invalid);
        return;
      }

      if (response.status === 401) {
        // The session is no longer accepted: back to the login screen.
        showLogin(LOOKUP_MESSAGES.unauthorized);
        return;
      }

      if (response.status === 403) {
        showLookupError(LOOKUP_MESSAGES.forbidden);
        return;
      }

      if (response.status === 404) {
        showLookupError(LOOKUP_MESSAGES.notFound);
        return;
      }

      showLookupError(LOOKUP_MESSAGES.server);
    } catch {
      showLookupError(LOOKUP_MESSAGES.offline);
    } finally {
      setLookupLoading(false);
    }
  });
});
