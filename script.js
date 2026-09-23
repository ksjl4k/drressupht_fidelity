document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("registration-form");
  const submitBtn = form ? form.querySelector('button[type="submit"]') : null;
  const message = document.getElementById("message");
  const welcomeName = document.getElementById("welcome-name");
  const displayMemberId = document.getElementById("display-member-id");
  const qrCodeContainer = document.getElementById("qrcode");
  const successCard = document.getElementById("success-card");

  if (form && submitBtn) {
    form.addEventListener("submit", async function (event) {
      event.preventDefault();

      if (submitBtn.disabled) return;
      submitBtn.disabled = true;
      if (message) message.textContent = "Inscription en cours...";

      const firstName = document.getElementById("first-name").value.trim();
      const lastName = document.getElementById("last-name").value.trim();
      const phone = document.getElementById("phone").value.trim();
      const email = document.getElementById("email").value.trim();
      const birthday = document.getElementById("birthday").value.trim();

      // 1. Save to Supabase
      const { data, error } = await supabaseClient
        .from("customers")
        .insert({
          first_name: firstName,
          last_name: lastName,
          phone: phone,
          email: email || null,
          birthday: birthday || null
        })
        .select()
        .single();

      if (error) {
        console.error(error);
        if (message) message.textContent = "Une erreur est survenue lors de l'inscription.";
        submitBtn.disabled = false;
        return;
      }

      // 2. Call the Square Edge Function directly using CONFIG key
      try {
        const squareSyncRes = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/sync-square`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${CONFIG.SUPABASE_ANON_KEY}`
          },
          body: JSON.stringify({ record: data })
        });

        const squareResult = await squareSyncRes.json();
        if (!squareSyncRes.ok) {
          console.error("Erreur de synchronisation Square:", squareResult);
        } else {
          console.log("Client synchronisé avec succès sur Square !", squareResult);
        }
      } catch (err) {
        console.error("Erreur réseau Edge Function:", err);
      }

      if (message) message.textContent = "";

      // Populate UI & QR Code
      if (welcomeName) welcomeName.textContent = data.first_name;
      if (displayMemberId) displayMemberId.textContent = data.dressup_member_id;

      if (qrCodeContainer) {
        qrCodeContainer.innerHTML = "";
        new QRCode(qrCodeContainer, {
          text: data.dressup_member_id,
          width: 180,
          height: 180,
          colorDark: "#136f9a",
          colorLight: "#ffffff",
          correctLevel: QRCode.CorrectLevel.H
        });
      }

      form.classList.add("hidden");
      if (successCard) successCard.classList.remove("hidden");
      form.reset();
      submitBtn.disabled = false;
    });
  }
});