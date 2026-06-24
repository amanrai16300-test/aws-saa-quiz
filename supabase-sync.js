(function () {
  "use strict";

  var TABLE_NAME = "quiz_progress";
  var HISTORY_TABLE = "quiz_history";
  var DEFAULT_STATUS = "Offline";
  var CONFIG = window.SUPABASE_QUIZ_CONFIG || {};
  var hasConfig =
    CONFIG.url &&
    CONFIG.anonKey &&
    CONFIG.url.indexOf("YOUR-PROJECT-REF") === -1 &&
    CONFIG.anonKey.indexOf("YOUR-PUBLIC") === -1;

  function now() {
    return Date.now();
  }

  function projectUrl(url) {
    try {
      return new URL(url).origin;
    } catch (error) {
      return url;
    }
  }

  function createNoopSync() {
    return {
      enabled: false,
      user: null,
      status: DEFAULT_STATUS,
      onStatusChange: function () {},
      onRemoteChange: function () {},
      setHistoryMerger: function () {},
      setPayloadVerifier: function () {},
      init: function () {
        this.emitStatus(DEFAULT_STATUS);
        return Promise.resolve(null);
      },
      emitStatus: function (status) {
        this.status = status;
        if (this.statusHandler) {
          this.statusHandler(status);
        }
      },
      signUp: function () {
        this.emitStatus("Offline");
        return Promise.reject(new Error("Supabase config is not set."));
      },
      login: function () {
        this.emitStatus("Offline");
        return Promise.reject(new Error("Supabase config is not set."));
      },
      logout: function () {
        this.emitStatus("Offline");
        return Promise.resolve();
      },
      resetPassword: function () {
        this.emitStatus("Offline");
        return Promise.reject(new Error("Supabase config is not set."));
      },
      queueSave: function () {},
      saveNow: function () {
        return Promise.resolve({ status: "offline" });
      },
      loadRemote: function () {
        return Promise.resolve(null);
      },
      saveHistoryEntry: function () {
        return Promise.resolve({ status: "offline" });
      },
      saveHistoryEntries: function () {
        return Promise.resolve({ status: "offline" });
      },
      loadHistoryRows: function () {
        return Promise.resolve([]);
      }
    };
  }

  function createSync() {
    if (!hasConfig || !window.supabase || !window.supabase.createClient) {
      return createNoopSync();
    }

    var client = window.supabase.createClient(
      projectUrl(CONFIG.url),
      CONFIG.anonKey
    );
    var saveTimer = null;
    var statusHandler = null;
    var remoteHandler = null;
    var getPayload = null;
    var currentUser = null;
    var saving = false;
    var channel = null;
    var historyMerger = null;
    var payloadVerifier = null;

    function mergeWithCloud(payload, remotePayload) {
      if (!historyMerger || !payload) {
        return payload;
      }

      var localHistory = Array.isArray(payload.history)
        ? payload.history
        : [];
      var cloudHistory =
        remotePayload && Array.isArray(remotePayload.history)
          ? remotePayload.history
          : [];
      var merged = historyMerger(cloudHistory, localHistory);

      if (!Array.isArray(merged)) {
        return payload;
      }

      payload.history = merged;
      return payload;
    }

    function emitStatus(status) {
      if (statusHandler) {
        statusHandler(status);
      }
    }

    function emitRemote(payload) {
      if (remoteHandler) {
        remoteHandler(payload);
      }
    }

    function unsubscribeRealtime() {
      if (channel) {
        client.removeChannel(channel);
        channel = null;
      }
    }

    function subscribeRealtime() {
      unsubscribeRealtime();

      if (!currentUser || !client.channel) {
        return;
      }

      channel = client
        .channel("quiz_progress_" + currentUser.id)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: TABLE_NAME,
            filter: "user_id=eq." + currentUser.id
          },
          function (change) {
            var row = normalizeRow(change.new);
            var localPayload = getPayload ? getPayload() : null;

            if (!row || !row.payload) {
              return;
            }

            if (
              localPayload &&
              row.payload.clientId === localPayload.clientId
            ) {
              emitStatus("Saved");
              return;
            }

            if (
              localPayload &&
              localPayload.updatedAtMs &&
              row.updatedAtMs &&
              localPayload.updatedAtMs > row.updatedAtMs
            ) {
              queueSave();
              return;
            }

            emitRemote(row.payload);
          }
        )
        .subscribe(function (status) {
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            emitStatus("Sync error");
          }
        });
    }

    function currentOrigin() {
      return window.location.origin === "null"
        ? window.location.href.split("#")[0]
        : window.location.origin + window.location.pathname;
    }

    function normalizeRow(row) {
      if (!row || !row.payload) {
        return null;
      }

      return {
        payload: row.payload,
        updatedAtMs: Number(row.updated_at_ms) || 0
      };
    }

    function readRow() {
      if (!currentUser) {
        return Promise.resolve(null);
      }

      return client
        .from(TABLE_NAME)
        .select("payload, updated_at_ms")
        .eq("user_id", currentUser.id)
        .maybeSingle()
        .then(function (result) {
          if (result.error) {
            throw result.error;
          }
          return normalizeRow(result.data);
        });
    }

    function historyRowFromEntry(entry) {
      return {
        id: String(entry.id),
        user_id: currentUser.id,
        entry: entry,
        timestamp_ms: Number(entry.timestamp) || 0
      };
    }

    function saveHistoryEntries(entries) {
      if (!currentUser) {
        return Promise.resolve({ status: "offline" });
      }

      var rows = (entries || [])
        .filter(function (entry) {
          return entry && entry.id && entry.mode !== "wrong";
        })
        .map(historyRowFromEntry);

      if (!rows.length) {
        return Promise.resolve({ status: "empty" });
      }

      return client
        .from(HISTORY_TABLE)
        .upsert(rows, { onConflict: "id" })
        .then(function (result) {
          if (result.error) {
            throw result.error;
          }
          return { status: "saved", count: rows.length };
        });
    }

    function saveHistoryEntry(entry) {
      return saveHistoryEntries([entry]);
    }

    function loadHistoryRows() {
      if (!currentUser) {
        return Promise.resolve([]);
      }

      return client
        .from(HISTORY_TABLE)
        .select("entry")
        .eq("user_id", currentUser.id)
        .then(function (result) {
          if (result.error) {
            throw result.error;
          }
          return (result.data || [])
            .map(function (row) {
              return row.entry;
            })
            .filter(Boolean);
        });
    }

    function upsertPayload(payload) {
      if (!currentUser) {
        emitStatus("Offline");
        return Promise.resolve({ status: "offline" });
      }

      saving = true;
      emitStatus("Saving");

      return readRow()
        .then(function (remote) {
          if (
            remote &&
            remote.updatedAtMs > payload.updatedAtMs &&
            remote.payload &&
            remote.payload.clientId !== payload.clientId
          ) {
            emitRemote(remote.payload);
            emitStatus("Saved");
            return { status: "remote-newer", payload: remote.payload };
          }

          mergeWithCloud(payload, remote ? remote.payload : null);

          return client
            .from(TABLE_NAME)
            .upsert({
              user_id: currentUser.id,
              payload: payload,
              updated_at_ms: payload.updatedAtMs
            })
            .select("payload, updated_at_ms")
            .single()
            .then(function (result) {
              if (result.error) {
                throw result.error;
              }

              // Read-back verification: prove the cloud row actually contains
              // the active main/wrong state we just wrote. The verifier knows
              // the quiz state shape; sync stays shape-agnostic.
              var cloudPayload = result.data ? result.data.payload : null;
              if (
                payloadVerifier &&
                !payloadVerifier(payload, cloudPayload)
              ) {
                emitStatus("Sync warning");
                return { status: "unverified", payload: cloudPayload };
              }

              emitStatus("Saved");
              return { status: "saved" };
            });
        })
        .catch(function (error) {
          emitStatus("Sync error");
          throw error;
        })
        .finally(function () {
          saving = false;
        });
    }

    function saveNow() {
      if (!getPayload || saving) {
        return Promise.resolve({ status: saving ? "busy" : "empty" });
      }
      clearTimeout(saveTimer);
      saveTimer = null;
      return upsertPayload(getPayload());
    }

    function queueSave() {
      if (!currentUser || !getPayload) {
        emitStatus(currentUser ? "Saved" : DEFAULT_STATUS);
        return;
      }
      emitStatus("Saving");
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNow, 500);
    }

    function handleSession(session) {
      currentUser = session && session.user ? session.user : null;
      if (currentUser) {
        subscribeRealtime();
      } else {
        unsubscribeRealtime();
      }
      emitStatus(currentUser ? "Saved" : DEFAULT_STATUS);
      return currentUser;
    }

    return {
      enabled: true,
      get user() {
        return currentUser;
      },
      onStatusChange: function (handler) {
        statusHandler = handler;
      },
      onRemoteChange: function (handler) {
        remoteHandler = handler;
      },
      setHistoryMerger: function (merger) {
        historyMerger = merger;
      },
      setPayloadVerifier: function (verifier) {
        payloadVerifier = verifier;
      },
      init: function (payloadReader) {
        getPayload = payloadReader;

        client.auth.onAuthStateChange(function (event, session) {
          handleSession(session);
          if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
            readRow()
              .then(function (remote) {
                emitRemote(remote ? remote.payload : null);
              })
              .catch(function () {
                emitStatus("Sync error");
              });
          }
        });

        return client.auth.getSession().then(function (result) {
          if (result.error) {
            throw result.error;
          }
          return handleSession(result.data.session);
        });
      },
      signUp: function (email, password) {
        return client.auth.signUp({ email: email, password: password });
      },
      login: function (email, password) {
        return client.auth.signInWithPassword({
          email: email,
          password: password
        });
      },
      logout: function () {
        return saveNow().finally(function () {
          unsubscribeRealtime();
        }).then(function () {
          return client.auth.signOut();
        });
      },
      resetPassword: function (email) {
        return client.auth.resetPasswordForEmail(email, {
          redirectTo: currentOrigin()
        });
      },
      queueSave: queueSave,
      saveNow: saveNow,
      loadRemote: readRow,
      saveHistoryEntry: saveHistoryEntry,
      saveHistoryEntries: saveHistoryEntries,
      loadHistoryRows: loadHistoryRows
    };
  }

  window.QuizSupabaseSync = {
    create: createSync
  };
})();
