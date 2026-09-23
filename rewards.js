document.addEventListener("DOMContentLoaded", () => {
  const supabaseClient = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  
  const loginForm = document.getElementById("rewards-login-form");
  const dashboard = document.getElementById("rewards-dashboard");
  const errorMsg = document.getElementById("error-message");
  const birthdayInput = document.getElementById("check-birthday");

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

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorMsg.textContent = "";

    const refId = document.getElementById("ref-id").value.trim().toLowerCase();
    const birthday = birthdayInput.value.trim();

    // Query Supabase for matching ID and Birthday
    const { data, error } = await supabaseClient
      .from("customers")
      .select("*")
      .eq("dressup_member_id", refId)
      .eq("birthday", birthday)
      .single();

    if (error || !data) {
      errorMsg.textContent = "Identifiant ou date de naissance incorrect.";
      return;
    }

    // Populate Dashboard Data
    document.getElementById("dash-name").textContent = data.first_name;
    document.getElementById("dash-id").textContent = data.dressup_member_id;
    document.getElementById("dash-points").textContent = data.points || 0; // Assuming you have a points column, or defaults to 0

    // Render QR Code
    const qrContainer = document.getElementById("qrcode");
    qrContainer.innerHTML = "";
    new QRCode(qrContainer, {
      text: data.dressup_member_id,
      width: 180,
      height: 180,
      colorDark: "#136f9a",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.H
    });

    // Switch views
    loginForm.classList.add("hidden");
    dashboard.classList.remove("hidden");
  });

  // Logout / Reset view
  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      dashboard.classList.add("hidden");
      loginForm.classList.remove("hidden");
      loginForm.reset();
    });
  }
});