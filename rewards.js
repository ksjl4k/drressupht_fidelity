// DressupHT - rewards page.
//
// This file used to log a visitor in with their member id plus date of birth,
// read `customers` and `purchases` straight from Supabase with the public anon
// key, and then invent a balance in the browser by truncating the sum of every
// order total. All of that is gone, on purpose:
//
//   * a balance is never a browser calculation. Points are awarded by
//     DressupHT when a qualifying order is recorded, and the balance is the sum
//     of the DressupHT ledger, which only the company backend can read;
//   * a date of birth is not a credential. There is no public login here, and
//     customers have no direct access to their ledger through the public API;
//   * Square Loyalty is not used for anything. Rewards are owned by DressupHT.
//
// The page is dormant until the company portal exists, so this script does not
// fetch anything, call Supabase, or compute points. When the page is
// activated, the balance must come from an authenticated, staff-checked source,
// and the QR code must encode the member id only.
document.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.loyaltyPage = "dormant";
});
