(function () {
  "use strict";

  var TABLE_NAME = "quiz_progress";
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

  function createNoopSync() {
    return {
      enabled: false,
      user: null,
      status: DEFAULT_STATUS,
      onStatusChange: function () {},
      onRemoteChange: function () {},
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
      }
    };
  }

  function createSync() {
    if (!hasConfig || !window.supabase || !window.supabase.createClient) {
      return createNoopSync();
    }

    var client = window.supabase.createClient(CONFIG.url, CONFIG.anonKey);
    var saveTimer = null;
    var statusHandler = null;
    var remoteHandler = null;
    var getPayload = null;
    var currentUser = null;
    var saving = false;

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

          return client
            .from(TABLE_NAME)
            .upsert({
              user_id: currentUser.id,
              payload: payload,
              updated_at_ms: payload.updatedAtMs
            })
            .select("updated_at_ms")
            .single()
            .then(function (result) {
              if (result.error) {
                throw result.error;
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
      saveTimer = setTimeout(saveNow, 900);
    }

    function handleSession(session) {
      currentUser = session && session.user ? session.user : null;
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
        return client.auth.signOut();
      },
      resetPassword: function (email) {
        return client.auth.resetPasswordForEmail(email, {
          redirectTo: currentOrigin()
        });
      },
      queueSave: queueSave,
      saveNow: saveNow,
      loadRemote: readRow
    };
  }

  window.QuizSupabaseSync = {
    create: createSync
  };
})();
