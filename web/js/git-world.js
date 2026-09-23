/*
 * Pocket Agents Git World Adapter
 * PA-GITWORLD/1
 *
 * Git is the durable game clock:
 *   repository   = universe
 *   world/live   = canonical timeline
 *   commit SHA   = checkpoint / continue code
 *   world/state.json = canonical snapshot for v1
 *
 * The adapter never stores credentials. Pass an authenticated writer at runtime.
 */
(function (global) {
  "use strict";

  const DEFAULTS = Object.freeze({
    owner: "918Tech",
    repo: "Pock3t--Ag3nts",
    liveBranch: "world/live",
    statePath: "world/state.json",
    apiBase: "https://api.github.com",
  });

  class GitWorldError extends Error {
    constructor(message, details = {}) {
      super(message);
      this.name = "GitWorldError";
      this.details = details;
    }
  }

  const utf8 = new TextEncoder();
  const utf8Decoder = new TextDecoder();

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === "object") {
      const out = {};
      for (const key of Object.keys(value).sort()) {
        out[key] = stableValue(value[key]);
      }
      return out;
    }
    return value;
  }

  function canonicalJSONString(value) {
    return JSON.stringify(stableValue(value));
  }

  function toBase64(text) {
    const bytes = utf8.encode(text);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function fromBase64(encoded) {
    const binary = atob(encoded.replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return utf8Decoder.decode(bytes);
  }

  async function sha256Hex(text) {
    if (!global.crypto?.subtle) {
      throw new GitWorldError(
        "WebCrypto SHA-256 is required for authoritative Git World state."
      );
    }
    const digest = await global.crypto.subtle.digest("SHA-256", utf8.encode(text));
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function computeStateRoot(state) {
    const projected = deepClone(state);
    projected.integrity ||= {};
    projected.integrity.stateRoot = null;
    return "sha256:" + (await sha256Hex(canonicalJSONString(projected)));
  }

  async function apiJSON(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.headers || {}),
      },
    });

    let body = null;
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      throw new GitWorldError(
        `GitHub request failed (${response.status})`,
        { status: response.status, body, url }
      );
    }

    return body;
  }

  function makeEventId(type) {
    const suffix = global.crypto?.randomUUID
      ? global.crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(16).slice(2, 14);
    return `${String(type || "EVENT").toUpperCase()}-${suffix}`;
  }

  class GitWorld {
    constructor(config = {}) {
      this.config = { ...DEFAULTS, ...config };
      this.writer = config.writer || null;
      this.current = null;
    }

    repoAPI(path) {
      const { apiBase, owner, repo } = this.config;
      return `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`;
    }

    async resolveHead(ref = this.config.liveBranch) {
      const data = await apiJSON(
        this.repoAPI(`/commits/${encodeURIComponent(ref)}`)
      );
      return {
        checkpoint: data.sha,
        message: data.commit?.message || "",
        date: data.commit?.committer?.date || null,
      };
    }

    async fetchState(ref = this.config.liveBranch) {
      const { statePath } = this.config;
      const data = await apiJSON(
        this.repoAPI(
          `/contents/${statePath
            .split("/")
            .map(encodeURIComponent)
            .join("/")}?ref=${encodeURIComponent(ref)}`
        )
      );

      if (Array.isArray(data) || data.type !== "file") {
        throw new GitWorldError("Canonical world path is not a file.", {
          ref,
          statePath,
        });
      }

      const state = JSON.parse(fromBase64(data.content));
      return {
        state,
        blobSha: data.sha,
      };
    }

    async verifyState(state) {
      if (!state || state.schema !== "PA-WORLD/1") {
        throw new GitWorldError("Unsupported Pocket Agents world schema.", {
          schema: state?.schema,
        });
      }

      if (state.integrity?.stateRoot) {
        const calculated = await computeStateRoot(state);
        if (calculated !== state.integrity.stateRoot) {
          throw new GitWorldError("World stateRoot verification failed.", {
            expected: state.integrity.stateRoot,
            calculated,
          });
        }
      }

      const invariantFn =
        global.POCKET?.invariants?.assertUniverse ||
        global.POCKET?.invariants?.assertWorld;

      if (typeof invariantFn === "function") {
        await invariantFn(state);
      }

      return true;
    }

    async load(ref = this.config.liveBranch) {
      const [head, snapshot] = await Promise.all([
        this.resolveHead(ref),
        this.fetchState(ref),
      ]);

      await this.verifyState(snapshot.state);

      const loaded = {
        ref,
        checkpoint: head.checkpoint,
        blobSha: snapshot.blobSha,
        state: snapshot.state,
        message: head.message,
        date: head.date,
      };

      if (ref === this.config.liveBranch) this.current = loaded;

      global.dispatchEvent(
        new CustomEvent("pocket:checkpoint-loaded", { detail: loaded })
      );

      return loaded;
    }

    async continueGame() {
      return this.load(this.config.liveBranch);
    }

    async loadCheckpoint(commitSha) {
      if (!/^[0-9a-f]{7,40}$/i.test(String(commitSha || ""))) {
        throw new GitWorldError("Invalid checkpoint SHA.", { commitSha });
      }
      return this.load(commitSha);
    }

    async checkpoint({ type, summary = "", payload = {}, mutate }) {
      if (!this.writer?.writeCheckpoint) {
        throw new GitWorldError(
          "No authenticated checkpoint writer is installed. Reads are available, writes are disabled."
        );
      }
      if (typeof mutate !== "function") {
        throw new GitWorldError("checkpoint() requires a pure state mutator.");
      }

      // Always reload HEAD before constructing the next durable state.
      const base = await this.continueGame();
      const next = deepClone(base.state);

      await mutate(next);

      next.world ||= {};
      next.world.sequence = Number(base.state.world?.sequence || 0) + 1;
      next.world.parentCheckpoint = base.checkpoint;
      next.world.lastEvent = {
        id: makeEventId(type),
        type: String(type || "EVENT").toUpperCase(),
        payload: deepClone(payload),
        at: new Date().toISOString(),
      };

      next.integrity ||= {};
      next.integrity.algorithm = "SHA-256";
      next.integrity.stateRoot = await computeStateRoot(next);

      await this.verifyState(next);

      const content = canonicalJSONString(next) + "\n";
      const message = [
        `PA/1 ${next.world.lastEvent.type}`,
        summary,
        "",
        `event: ${next.world.lastEvent.id}`,
        `sequence: ${next.world.sequence}`,
        `parent-checkpoint: ${base.checkpoint}`,
        `state-root: ${next.integrity.stateRoot}`,
      ]
        .filter((line, index, arr) => !(line === "" && arr[index - 1] === ""))
        .join("\n");

      const written = await this.writer.writeCheckpoint({
        owner: this.config.owner,
        repo: this.config.repo,
        branch: this.config.liveBranch,
        statePath: this.config.statePath,
        expectedCommitSha: base.checkpoint,
        expectedBlobSha: base.blobSha,
        message,
        content,
      });

      if (!written?.commitSha) {
        throw new GitWorldError("Writer did not return a checkpoint commit SHA.");
      }

      const saved = {
        ref: this.config.liveBranch,
        checkpoint: written.commitSha,
        blobSha: written.blobSha || null,
        state: next,
        message,
        date: new Date().toISOString(),
      };

      this.current = saved;
      global.dispatchEvent(
        new CustomEvent("pocket:checkpoint-saved", { detail: saved })
      );
      return saved;
    }

    async branchFromCheckpoint({ checkpoint, branch }) {
      if (!this.writer?.createBranch) {
        throw new GitWorldError("Writer does not support timeline branching.");
      }
      if (!checkpoint || !branch) {
        throw new GitWorldError("checkpoint and branch are required.");
      }
      return this.writer.createBranch({
        owner: this.config.owner,
        repo: this.config.repo,
        checkpoint,
        branch,
      });
    }
  }

  /*
   * Direct GitHub writer for development/single-owner use.
   * Supply a token at runtime only. Never hard-code or persist it in Pages,
   * LittleFS, source, localStorage, or the repository.
   *
   * Multiplayer should replace this with a GitHub App-backed writer.
   */
  function createDirectGitHubWriter({ token }) {
    if (!token) throw new GitWorldError("Runtime GitHub token is required.");

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };

    function repoAPI(owner, repo, path) {
      return `https://api.github.com/repos/${encodeURIComponent(
        owner
      )}/${encodeURIComponent(repo)}${path}`;
    }

    return {
      async writeCheckpoint({
        owner,
        repo,
        branch,
        statePath,
        expectedCommitSha,
        expectedBlobSha,
        message,
        content,
      }) {
        // Explicit HEAD check. The blob SHA in PUT is a second CAS guard.
        const head = await apiJSON(
          repoAPI(owner, repo, `/commits/${encodeURIComponent(branch)}`),
          { headers }
        );

        if (head.sha !== expectedCommitSha) {
          throw new GitWorldError("Checkpoint conflict: world HEAD advanced.", {
            expectedCommitSha,
            actualCommitSha: head.sha,
          });
        }

        const result = await apiJSON(
          repoAPI(
            owner,
            repo,
            `/contents/${statePath
              .split("/")
              .map(encodeURIComponent)
              .join("/")}`
          ),
          {
            method: "PUT",
            headers,
            body: JSON.stringify({
              message,
              content: toBase64(content),
              branch,
              sha: expectedBlobSha,
            }),
          }
        );

        return {
          commitSha: result.commit?.sha,
          blobSha: result.content?.sha,
        };
      },

      async createBranch({ owner, repo, checkpoint, branch }) {
        const result = await apiJSON(repoAPI(owner, repo, "/git/refs"), {
          method: "POST",
          headers,
          body: JSON.stringify({
            ref: `refs/heads/${branch}`,
            sha: checkpoint,
          }),
        });
        return {
          branch: result.ref?.replace(/^refs\/heads\//, "") || branch,
          checkpoint: result.object?.sha || checkpoint,
        };
      },
    };
  }

  function install(config = {}) {
    global.POCKET ||= {};
    const gitWorld = new GitWorld(config);
    global.POCKET.gitWorld = gitWorld;
    return gitWorld;
  }

  global.PocketGitWorld = Object.freeze({
    GitWorld,
    GitWorldError,
    install,
    createDirectGitHubWriter,
    canonicalJSONString,
    computeStateRoot,
  });
})(window);
