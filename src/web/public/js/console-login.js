(() => {
  const form = document.getElementById("loginForm");
  const message = document.getElementById("message");
  const request = async (url, options = {}) => {
    const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success) throw new Error(body?.message || `请求失败：HTTP ${response.status}`);
    return body.data;
  };
  const bytes = (value) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (item) => item.charCodeAt(0));
  const base64Url = (value) => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  async function proof(password, username, challenge) {
    if (!window.crypto?.subtle) throw new Error("当前页面不支持安全登录。请通过 HTTPS 打开控制台，或在本机 127.0.0.1 访问。");
    const passwordKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: bytes(challenge.salt), iterations: Number(challenge.iterations), hash: "SHA-256" }, passwordKey, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
    return base64Url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${challenge.nonce}\n${username.trim()}`)));
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); message.textContent = "正在安全验证…";
    const button = form.querySelector("button"); button.disabled = true;
    try {
      const challenge = await request("/api/console-auth/challenge");
      const username = document.getElementById("username").value;
      await request("/api/console-auth/login", { method: "POST", body: JSON.stringify({ challengeId: challenge.challengeId, username, proof: await proof(document.getElementById("password").value, username, challenge), remember: document.getElementById("remember").checked }) });
      window.location.replace("/");
    } catch (error) { message.textContent = error.message; } finally { button.disabled = false; }
  });
})();
