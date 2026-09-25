document.addEventListener("DOMContentLoaded", async () => {
  const supabaseClient = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  
  const loginForm = document.getElementById("rewards-login-form");
  const dashboard = document.getElementById("rewards-dashboard");
  const errorMsg = document.getElementById("error-message");
  const birthdayInput = document.getElementById("check-birthday");
  const qrToggleBtn = document.getElementById("qr-toggle-btn");
  const qrContainer = document.getElementById("qrcode");
  let qrGenerated = false;
  let qrMemberId = "";

  // Validate birthday as a real DD/MM date
  const isValidBirthday = (value) => {
    const match = value.match(/^(\d{2})\/(\d{2})$/);
    if (!match) return false;
    const dd = parseInt(match[1], 10);
    const mm = parseInt(match[2], 10);
    if (mm < 1 || mm > 12) return false;
    const daysInMonth = new Date(2000, mm, 0).getDate();
    return dd >= 1 && dd <= daysInMonth;
  };

  // Auto-format birthday input as DD/MM
  if (birthdayInput) {
    birthdayInput.addEventListener("input", (e) => {
      let value = e.target.value.replace(/\D/g, "");
      if (value.length > 4) value = value.slice(0, 4);
      if (value.length >= 3) {
        value = value.slice(0, 2) + "/" + value.slice(2);
      }
      e.target.value = value;
    });
  }

  // ---------------------------------------------------------------------------
  // Reward progress + encouragement (TEMPORARY loyalty rules).
  // The target is randomized and kept per-member in sessionStorage so it stays
  // stable for the session. This block is fully isolated so it can easily be
  // swapped for the real DressupHT loyalty rules later.
  // ---------------------------------------------------------------------------
  const REWARD_RULES = {
    minGoal: 500,
    maxGoal: 2000,
    nearlyThereRatio: 0.15,
    storageKey: "dressupht_reward_goal"
  };

  const CONFETTI_COLORS = ["#d4af37", "#e9d9a0", "#3ea8d6", "#136f9a", "#ffffff"];
  let confettiTimer = null;

  const getRewardGoal = (memberId, totalPoints) => {
    const { minGoal, maxGoal, storageKey } = REWARD_RULES;
    const key = `${storageKey}:${memberId}`;
    try {
      const stored = parseInt(sessionStorage.getItem(key) || "", 10);
      if (Number.isInteger(stored) && stored > totalPoints) return stored;
    } catch (err) {
      // storage unavailable — fall through to a fresh target
    }
    const goal = minGoal + Math.floor(Math.random() * (maxGoal - minGoal + 1));
    const finalGoal = goal > totalPoints ? goal : totalPoints + minGoal;
    try {
      sessionStorage.setItem(key, String(finalGoal));
    } catch (err) {
      // storage unavailable — target still works for this load
    }
    return finalGoal;
  };

  const launchConfetti = (container, { excited = true } = {}) => {
    if (!container) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Making sure a previous burst is fully cleaned up before starting a new one.
    if (confettiTimer) {
      clearTimeout(confettiTimer);
      confettiTimer = null;
    }

    const fallDistance = (container.offsetHeight || 280) + 24;
    const count = excited ? 32 : 20;
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < count; i++) {
      const piece = document.createElement("span");
      piece.className = "confetti-piece";
      const size = 5 + Math.random() * 6;
      piece.style.width = `${size}px`;
      piece.style.height = `${size * (Math.random() > 0.5 ? 1 : 0.55)}px`;
      piece.style.borderRadius = Math.random() > 0.5 ? "50%" : "2px";
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
      piece.style.animationDelay = `${(Math.random() * 0.45).toFixed(2)}s`;
      piece.style.animationDuration = `${(1.3 + Math.random() * 1.2).toFixed(2)}s`;
      piece.style.setProperty("--fall", `${fallDistance}px`);
      fragment.appendChild(piece);
    }

    container.innerHTML = "";
    container.appendChild(fragment);

    confettiTimer = setTimeout(() => {
      container.innerHTML = "";
      confettiTimer = null;
    }, 2300);
  };

  const renderRewardProgress = (totalPoints, memberId) => {
    const goal = getRewardGoal(memberId, totalPoints);
    const remaining = Math.max(goal - totalPoints, 0);
    const pct = Math.round(Math.min(totalPoints / goal, 1) * 100);

    const pointsEl = document.getElementById("reward-nudge-points");
    const goalEl = document.getElementById("reward-nudge-goal");
    const statusEl = document.getElementById("reward-nudge-status");
    const messageEl = document.getElementById("reward-nudge-message");
    const fillEl = document.getElementById("reward-nudge-fill");
    const trackEl = document.getElementById("reward-nudge-track");
    const confettiEl = document.getElementById("reward-confetti");

    if (pointsEl) pointsEl.textContent = totalPoints.toLocaleString("fr-FR");
    if (goalEl) goalEl.textContent = `Objectif : ${goal.toLocaleString("fr-FR")} pts`;
    if (fillEl) fillEl.style.width = `${pct}%`;
    if (trackEl) trackEl.setAttribute("aria-valuenow", String(pct));

    const unlocked = totalPoints >= goal;
    const nearlyThere =
      !unlocked &&
      totalPoints > 0 &&
      remaining <= Math.ceil(goal * REWARD_RULES.nearlyThereRatio);

    if (messageEl) {
      if (unlocked) {
        messageEl.textContent = "Récompense débloquée, félicitations !";
        messageEl.classList.remove("reward-nudge-message--excited");
      } else if (nearlyThere) {
        messageEl.textContent = "Presque là ! Encore un petit effort pour débloquer votre récompense !";
        messageEl.classList.add("reward-nudge-message--excited");
      } else {
        messageEl.textContent = "Vous vous rapprochez de votre prochaine récompense !";
        messageEl.classList.remove("reward-nudge-message--excited");
      }
    }

    if (statusEl) {
      statusEl.textContent = unlocked
        ? "Vous avez atteint votre objectif, profitez de votre récompense !"
        : `Plus que ${remaining.toLocaleString("fr-FR")} pts avant votre prochaine récompense.`;
    }

    const nudge = document.getElementById("reward-nudge");
    if (nudge) {
      nudge.classList.remove("reward-nudge--ready");
      void nudge.offsetWidth;
      nudge.classList.add("reward-nudge--ready");
    }

    launchConfetti(confettiEl, { excited: unlocked || nearlyThere });
  };

  const loadCustomerDashboard = async (referenceId, birthday) => {
    // 1. Query Supabase for matching ID and Birthday
    const { data: customer, error } = await supabaseClient
      .from("customers")
      .select("*")
      .eq("dressup_member_id", referenceId)
      .eq("birthday", birthday)
      .single();

    if (error || !customer) {
      return null;
    }

    // 2. Fetch purchases for this customer
    const { data: purchases, error: purError } = await supabaseClient
      .from("purchases")
      .select("*")
      .eq("customer_id", customer.id)
      .order("created_at", { ascending: false });

    if (purError) {
      console.error("Erreur lors de la récupération des achats:", purError);
    }

    // Populate Dashboard Data
    document.getElementById("dash-name").textContent = customer.first_name;
    document.getElementById("dash-id").textContent = customer.dressup_member_id;

    // Populate Membership Card
    document.getElementById("membership-card-name").textContent = `${customer.first_name} ${customer.last_name}`;
    document.getElementById("membership-since").textContent = new Date(customer.created_at).toLocaleDateString("fr-FR", {
      month: "short",
      year: "numeric"
    });
    document.getElementById("membership-card-id").textContent = customer.dressup_member_id;
    
    // Calculate total points (e.g., 1 point per currency unit spent, or default to 0)
    const totalSpent = purchases ? purchases.reduce((sum, p) => sum + Number(p.total_amount), 0) : 0;
    document.getElementById("dash-points").textContent = Math.floor(totalSpent); // 1 point per HTG spent (adjust if needed)

    // Render Purchases History List
    const purchasesListContainer = document.getElementById("purchases-list");
    if (purchasesListContainer) {
      purchasesListContainer.innerHTML = "";

      if (!purchases || purchases.length === 0) {
        purchasesListContainer.innerHTML = `<p style="font-size: 13px; color: #666; text-align: center; margin-top: 10px;">Aucun achat récent enregistré.</p>`;
      } else {
        purchases.forEach(pur => {
          const dateStr = new Date(pur.created_at).toLocaleDateString("fr-FR", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric"
          });

          // Build items description
          let itemsText = "Articles divers";
          if (pur.items && Array.isArray(pur.items) && pur.items.length > 0) {
            itemsText = pur.items.map(i => `${i.quantity || 1}x ${i.name}`).join(", ");
          }

          const purchaseCard = document.createElement("div");
          purchaseCard.style.cssText = "background: #ffffff; border: 1px solid #e1ded8; padding: 12px; border-radius: 6px; margin-bottom: 10px; text-align: left;";
          purchaseCard.innerHTML = `
            <div style="display: flex; justify-content: space-between; font-size: 12px; color: #666; margin-bottom: 4px;">
              <span>${dateStr}</span>
              <strong style="color: #136f9a;">${pur.total_amount} ${pur.currency || 'HTG'}</strong>
            </div>
            <div style="font-size: 13px; color: #2c3e50; font-weight: 500;">${itemsText}</div>
          `;
          purchasesListContainer.appendChild(purchaseCard);
        });
      }
    }

    // Store member ID for on-demand QR code generation
    qrMemberId = customer.dressup_member_id;
    qrGenerated = false;

    // Switch views (done before rendering progress so the confetti can measure
    // the visible section)
    loginForm.classList.add("hidden");
    dashboard.classList.remove("hidden");

    // Render reward progress + encouragement (runs once per dashboard load)
    renderRewardProgress(Math.floor(totalSpent), customer.dressup_member_id);

    return customer;
  };

  const storedSession = localStorage.getItem("dressupht_session");
  if (storedSession) {
    try {
      const session = JSON.parse(storedSession);
      if (session && typeof session.id === "string" && typeof session.birthday === "string") {
        const restored = await loadCustomerDashboard(
          session.id.trim().toLowerCase(),
          session.birthday.trim()
        );

        if (!restored) {
          localStorage.removeItem("dressupht_session");
        }
      } else {
        localStorage.removeItem("dressupht_session");
      }
    } catch (err) {
      localStorage.removeItem("dressupht_session");
    }
  }

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorMsg.textContent = "";

    const refId = document.getElementById("ref-id").value.trim().toLowerCase();
    const birthday = birthdayInput.value.trim();

    if (!isValidBirthday(birthday)) {
      errorMsg.textContent = "Date de naissance invalide (format JJ/MM).";
      return;
    }

    const customer = await loadCustomerDashboard(refId, birthday);

    if (!customer) {
      errorMsg.textContent = "Identifiant ou date de naissance incorrect.";
      return;
    }

    localStorage.setItem(
      "dressupht_session",
      JSON.stringify({ id: refId, birthday })
    );
  });

  if (qrToggleBtn) {
    qrToggleBtn.addEventListener("click", () => {
      const showing = qrContainer.classList.toggle("hidden") === false;
      qrToggleBtn.textContent = showing ? "Masquer mon QR code" : "Afficher mon QR code";

      if (showing && !qrGenerated) {
        qrContainer.innerHTML = "";
        new QRCode(qrContainer, {
          text: qrMemberId,
          width: 180,
          height: 180,
          colorDark: "#136f9a",
          colorLight: "#ffffff",
          correctLevel: QRCode.CorrectLevel.H
        });
        qrGenerated = true;
      }
    });
  }

  const historyToggleBtn = document.getElementById("history-toggle-btn");
  if (historyToggleBtn) {
    historyToggleBtn.addEventListener("click", () => {
      const showing = document.getElementById("purchases-list").classList.toggle("hidden") === false;
      historyToggleBtn.textContent = showing
        ? "Masquer l'historique des achats"
        : "Afficher l'historique des achats";
    });
  }

  // Logout / Reset view
  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      localStorage.removeItem("dressupht_session");
      qrGenerated = false;
      qrMemberId = "";

      if (qrContainer) {
        qrContainer.classList.add("hidden");
        qrContainer.innerHTML = "";
      }
      qrToggleBtn.textContent = "Afficher mon QR code";
      const purchasesList = document.getElementById("purchases-list");
      if (purchasesList) {
        purchasesList.classList.add("hidden");
      }
      historyToggleBtn.textContent = "Afficher l'historique des achats";
      dashboard.classList.add("hidden");
      loginForm.classList.remove("hidden");
      loginForm.reset();
    });
  }
});