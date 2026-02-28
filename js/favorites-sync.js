(function (global) {
  const STORAGE_KEYS = {
    favoritePaperIds: "favoritePaperIds",
    favoriteSyncPending: "favoriteSyncPending",
    favoriteGithubPat: "favoriteGithubPat",
    favoriteGithubLogin: "favoriteGithubLogin",
    favoriteLastSyncAt: "favoriteLastSyncAt",
  };

  function safeParseJson(text, fallback) {
    if (!text) return fallback;
    try {
      return JSON.parse(text);
    } catch (_error) {
      return fallback;
    }
  }

  function toBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function fromBase64Utf8(base64) {
    const binary = atob((base64 || "").replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }

  function normalizeFavoriteIds(ids) {
    if (!Array.isArray(ids)) return [];
    const seen = new Set();
    const out = [];
    ids.forEach((value) => {
      const id = String(value || "").trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push(id);
    });
    return out;
  }

  function getFavoritePaperIds() {
    const ids = safeParseJson(localStorage.getItem(STORAGE_KEYS.favoritePaperIds), []);
    return normalizeFavoriteIds(ids);
  }

  function setFavoritePaperIds(ids) {
    const normalized = normalizeFavoriteIds(ids);
    localStorage.setItem(STORAGE_KEYS.favoritePaperIds, JSON.stringify(normalized));
    return normalized;
  }

  function getFavoriteGithubPat() {
    return (localStorage.getItem(STORAGE_KEYS.favoriteGithubPat) || "").trim();
  }

  function setFavoriteGithubPat(pat) {
    localStorage.setItem(STORAGE_KEYS.favoriteGithubPat, String(pat || "").trim());
  }

  function clearFavoriteGithubPat() {
    localStorage.removeItem(STORAGE_KEYS.favoriteGithubPat);
  }

  function getFavoriteGithubLogin() {
    return (localStorage.getItem(STORAGE_KEYS.favoriteGithubLogin) || "").trim();
  }

  function setFavoriteGithubLogin(login) {
    localStorage.setItem(STORAGE_KEYS.favoriteGithubLogin, String(login || "").trim());
  }

  function clearFavoriteGithubLogin() {
    localStorage.removeItem(STORAGE_KEYS.favoriteGithubLogin);
  }

  function getFavoriteLastSyncAt() {
    return (localStorage.getItem(STORAGE_KEYS.favoriteLastSyncAt) || "").trim();
  }

  function setFavoriteLastSyncAt(isoTime) {
    if (!isoTime) return;
    localStorage.setItem(STORAGE_KEYS.favoriteLastSyncAt, isoTime);
  }

  function setFavoriteSyncPending(payload) {
    localStorage.setItem(STORAGE_KEYS.favoriteSyncPending, JSON.stringify(payload || {}));
  }

  function clearFavoriteSyncPending() {
    localStorage.removeItem(STORAGE_KEYS.favoriteSyncPending);
  }

  function getFavoriteSyncPending() {
    return safeParseJson(localStorage.getItem(STORAGE_KEYS.favoriteSyncPending), {});
  }

  function isRepoSyncEnabled() {
    return Boolean(getFavoriteGithubPat() && getFavoriteGithubLogin());
  }

  function getFavoriteSyncState() {
    const pending = getFavoriteSyncPending();
    return {
      enabled: isRepoSyncEnabled(),
      pending: Boolean(pending.pending),
      lastError: pending.lastError || "",
      lastSyncAt: getFavoriteLastSyncAt() || "",
    };
  }

  function getDataConfig() {
    if (typeof DATA_CONFIG !== "undefined" && DATA_CONFIG) {
      return DATA_CONFIG;
    }
    if (global.DATA_CONFIG) {
      return global.DATA_CONFIG;
    }
    throw new Error("DATA_CONFIG is not available.");
  }

  function getRepoConfig() {
    const dataConfig = getDataConfig();
    return {
      repoOwner: dataConfig.repoOwner,
      repoName: dataConfig.repoName,
      dataBranch: dataConfig.dataBranch || "data",
    };
  }

  function getFavoriteFilePath(login) {
    return `favorites/${login}.json`;
  }

  async function githubRequest(url, pat, init = {}) {
    const headers = Object.assign({}, init.headers || {}, {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
    });
    if (init.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(url, Object.assign({}, init, { headers }));
    return response;
  }

  async function parseGithubError(response) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      if (payload && payload.message) {
        message = payload.message;
      }
    } catch (_error) {
      // ignore
    }
    return message;
  }

  async function validatePat(pat) {
    const token = String(pat || "").trim();
    if (!token) {
      throw new Error("GitHub PAT is required.");
    }
    const response = await githubRequest("https://api.github.com/user", token, { method: "GET" });
    if (!response.ok) {
      const message = await parseGithubError(response);
      throw new Error(`PAT validation failed: ${message}`);
    }
    const data = await response.json();
    if (!data || !data.login) {
      throw new Error("PAT validation failed: missing login.");
    }
    return { login: data.login };
  }

  function normalizeRemoteFavoriteItems(items) {
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => {
        if (!item || !item.paper_id) return null;
        return {
          paper_id: String(item.paper_id).trim(),
          added_at: item.added_at || "",
          title: item.title || "",
          abs_url: item.abs_url || "",
          date: item.date || "",
        };
      })
      .filter((item) => item && item.paper_id);
  }

  async function fetchRemoteFavorites(login, pat) {
    const { repoOwner, repoName, dataBranch } = getRepoConfig();
    const filePath = getFavoriteFilePath(login);
    const url = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${filePath}?ref=${encodeURIComponent(
      dataBranch
    )}`;
    const response = await githubRequest(url, pat, { method: "GET" });

    if (response.status === 404) {
      return { exists: false, sha: null, payload: null, items: [] };
    }
    if (!response.ok) {
      const message = await parseGithubError(response);
      throw new Error(`Load remote favorites failed: ${message}`);
    }

    const content = await response.json();
    const decoded = fromBase64Utf8(content.content || "");
    const payload = safeParseJson(decoded, {});
    return {
      exists: true,
      sha: content.sha || null,
      payload: payload,
      items: normalizeRemoteFavoriteItems(payload.items || []),
    };
  }

  function mergeFavoriteIds(localFavoriteIds, remoteItems) {
    const merged = new Set();
    normalizeRemoteFavoriteItems(remoteItems).forEach((item) => merged.add(item.paper_id));
    normalizeFavoriteIds(localFavoriteIds).forEach((id) => merged.add(id));
    return Array.from(merged);
  }

  function buildFavoritePayload(login, favoriteIds, paperIndexMap, remoteItems) {
    const now = new Date().toISOString();
    const remoteMap = new Map(
      normalizeRemoteFavoriteItems(remoteItems).map((item) => [item.paper_id, item])
    );
    const ids = normalizeFavoriteIds(favoriteIds);

    const items = ids.map((paperId) => {
      const snapshot = (paperIndexMap && paperIndexMap[paperId]) || {};
      const remote = remoteMap.get(paperId) || {};
      return {
        paper_id: paperId,
        added_at: remote.added_at || now,
        title: snapshot.title || remote.title || paperId,
        abs_url: snapshot.abs_url || snapshot.url || remote.abs_url || "",
        date: snapshot.date || remote.date || "",
      };
    });

    return {
      version: 1,
      owner: login,
      updated_at: now,
      items,
    };
  }

  async function putRemoteFavorites(login, pat, payload, sha) {
    const { repoOwner, repoName, dataBranch } = getRepoConfig();
    const filePath = getFavoriteFilePath(login);
    const url = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${filePath}`;
    const body = {
      message: `chore(favorites): update ${login} favorites`,
      content: toBase64Utf8(JSON.stringify(payload, null, 2)),
      branch: dataBranch,
    };
    if (sha) {
      body.sha = sha;
    }

    const response = await githubRequest(url, pat, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return response;
  }

  async function syncFavoritesToRepo(params) {
    const options = params || {};
    const pat = (options.pat || getFavoriteGithubPat() || "").trim();
    const login = (options.login || getFavoriteGithubLogin() || "").trim();
    const favoriteIds = normalizeFavoriteIds(options.favoriteIds || getFavoritePaperIds());
    const paperIndexMap = options.paperIndexMap || {};

    if (!pat || !login) {
      return { ok: false, reason: "not_configured" };
    }

    const executeOnce = async () => {
      const remote = await fetchRemoteFavorites(login, pat);
      const payload = buildFavoritePayload(login, favoriteIds, paperIndexMap, remote.items);
      const response = await putRemoteFavorites(login, pat, payload, remote.sha);
      return { response, payload };
    };

    try {
      let { response, payload } = await executeOnce();
      if (response.status === 409) {
        const retry = await executeOnce();
        response = retry.response;
        payload = retry.payload;
      }

      if (!response.ok) {
        const message = await parseGithubError(response);
        throw new Error(`Sync favorites failed: ${message}`);
      }

      setFavoriteLastSyncAt(payload.updated_at);
      clearFavoriteSyncPending();
      return { ok: true, syncedAt: payload.updated_at };
    } catch (error) {
      setFavoriteSyncPending({
        pending: true,
        lastError: error.message || String(error),
        updatedAt: new Date().toISOString(),
      });
      return { ok: false, error: error.message || String(error) };
    }
  }

  async function fetchRemoteFavoritesForCurrentUser() {
    const pat = getFavoriteGithubPat();
    const login = getFavoriteGithubLogin();
    if (!pat || !login) {
      return { exists: false, sha: null, payload: null, items: [] };
    }
    return fetchRemoteFavorites(login, pat);
  }

  global.FavoritesSync = {
    STORAGE_KEYS,
    getFavoritePaperIds,
    setFavoritePaperIds,
    getFavoriteGithubPat,
    setFavoriteGithubPat,
    clearFavoriteGithubPat,
    getFavoriteGithubLogin,
    setFavoriteGithubLogin,
    clearFavoriteGithubLogin,
    getFavoriteLastSyncAt,
    setFavoriteLastSyncAt,
    setFavoriteSyncPending,
    clearFavoriteSyncPending,
    getFavoriteSyncPending,
    getFavoriteSyncState,
    isRepoSyncEnabled,
    getFavoriteFilePath,
    validatePat,
    fetchRemoteFavorites,
    fetchRemoteFavoritesForCurrentUser,
    mergeFavoriteIds,
    syncFavoritesToRepo,
  };
})(window);
