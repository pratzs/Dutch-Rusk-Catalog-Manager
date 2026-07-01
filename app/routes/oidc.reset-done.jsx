export default function ResetDone() {
  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.h1}>Password updated</h1>
        <p>Your password has been saved. You can now sign in on the Dutch Rusk storefront with your new password.</p>
        <a href="https://dutchrusk.co.nz/account/login" style={styles.btn}>Go to Dutch Rusk</a>
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: "100vh", background: "#f6f6f7", display: "grid", placeItems: "center", padding: 24, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" },
  card: { width: "100%", maxWidth: 420, background: "white", borderRadius: 12, boxShadow: "0 2px 12px rgba(0,0,0,0.08)", padding: 32, textAlign: "center" },
  h1: { fontSize: 20, margin: "0 0 12px 0" },
  btn: { display: "inline-block", marginTop: 20, background: "#111827", color: "white", padding: "10px 18px", borderRadius: 6, fontSize: 15, textDecoration: "none" },
};
