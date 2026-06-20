
(function () {
  "use strict";

  var QUESTIONS = window.QUIZ_QUESTIONS || [];
  var POOL_SIZE = QUESTIONS.length;
  var MAIN_SESSION_SIZE = 64;
  var DISPLAY_LETTERS = ["A", "B", "C", "D", "E", "F"];
  var STORAGE_KEY = "aws_saa_c03_q1_684_cycle_history_wrong_practice_v2";
  var HISTORY_KEY = STORAGE_KEY + "_history";
  var SYNC_META_KEY = STORAGE_KEY + "_sync_meta";
  var CLIENT_ID_KEY = STORAGE_KEY + "_client_id";
  var HISTORY_MIGRATED_KEY = STORAGE_KEY + "_history_migrated";
  var timerHandle = null;
  var state = null;
  var ui = {};
  var sync = null;
  var currentView = "intro";
  var localUpdatedAt = 0;
  var applyingRemote = false;

  function element(id) {
    return document.getElementById(id);
  }

  function cacheElements() {
    [
      "diagnostic", "introCard", "pausedCard", "quizArea", "resultsCard",
      "continueBtn", "newMainBtn", "currentWrongBtn", "resetAllBtn",
      "pauseTopBtn", "resumeBtn", "returnFromPauseBtn", "pauseBtn",
      "previousBtn", "submitBtn", "nextBtn", "wrongRetestBtn",
      "reviewBtn", "nextMainResultsBtn", "returnToPreviousBtn",
      "clearHistoryBtn", "cycleStatus", "statMode", "statProgress",
      "statCorrect", "statWrong", "statTime", "progressBar",
      "sessionPosition", "sourceQuestion", "cycleBadge", "questionText",
      "multiHint", "options", "feedback", "resultsTitle", "finalScore",
      "finalPercentage", "finalWrong", "finalTime", "resultsNote",
      "reviewArea", "historyBar", "historyList", "syncStatus",
      "authEmail", "authPassword", "authLoginBtn", "authSignUpBtn",
      "authResetBtn", "authLogoutBtn", "authUser", "pauseSavedText",
      "resumeMainQuizBtn", "nextMainQuizBtn", "nextMainPausedBtn",
      "resumeWrongIntroBtn", "resumeWrongQuizBtn"
    ].forEach(function (id) {
      ui[id] = element(id);
    });
  }

  function storageWorks() {
    try {
      var testKey = "__quiz_storage_test__";
      localStorage.setItem(testKey, testKey);
      localStorage.removeItem(testKey);
      return true;
    } catch (error) {
      return false;
    }
  }

  var storageAvailable = storageWorks();

  function shuffle(values) {
    var copy = values.slice();
    for (var index = copy.length - 1; index > 0; index -= 1) {
      var randomIndex = Math.floor(Math.random() * (index + 1));
      var temporary = copy[index];
      copy[index] = copy[randomIndex];
      copy[randomIndex] = temporary;
    }
    return copy;
  }

  function unique(values) {
    var seen = {};
    var output = [];
    values.forEach(function (value) {
      var key = String(value);
      if (!seen[key]) {
        seen[key] = true;
        output.push(value);
      }
    });
    return output;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function readMeta() {
    if (!storageAvailable) {
      return {};
    }

    try {
      return JSON.parse(localStorage.getItem(SYNC_META_KEY) || "{}");
    } catch (error) {
      return {};
    }
  }

  function writeMeta(meta) {
    if (!storageAvailable) {
      return;
    }

    try {
      localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta));
    } catch (error) {}
  }

  function clientId() {
    if (!storageAvailable) {
      return "memory_" + Date.now().toString(36);
    }

    try {
      var existing = localStorage.getItem(CLIENT_ID_KEY);
      if (existing) {
        return existing;
      }

      var created =
        "client_" +
        Date.now().toString(36) +
        "_" +
        Math.random().toString(36).slice(2, 9);
      localStorage.setItem(CLIENT_ID_KEY, created);
      return created;
    } catch (error) {
      return "memory_" + Date.now().toString(36);
    }
  }

  function inferredLocalUpdatedAt(history) {
    var newest = state && state.createdAt ? state.createdAt : 0;

    (history || []).forEach(function (entry) {
      newest = Math.max(newest, entry.timestamp || 0);
    });

    return newest || Date.now();
  }

  function touchLocalUpdatedAt() {
    if (applyingRemote) {
      return;
    }

    localUpdatedAt = Date.now();
    writeMeta({
      updatedAtMs: localUpdatedAt,
      clientId: clientId()
    });
  }

  function setLocalUpdatedAt(value) {
    localUpdatedAt = Number(value) || Date.now();
    writeMeta({
      updatedAtMs: localUpdatedAt,
      clientId: clientId()
    });
  }

  function syncPayload() {
    return {
      version: 1,
      clientId: clientId(),
      updatedAtMs: localUpdatedAt || Date.now(),
      state: stateForCloud(state),
      history: mergeHistory(loadHistory(), [])
    };
  }

  function queueCloudSave() {
    if (!applyingRemote && sync && sync.user) {
      sync.queueSave();
    } else {
      renderSyncStatus(sync && sync.user ? "Saved" : "Offline");
    }
  }

  function flushCloudSave() {
    if (!applyingRemote && sync && sync.user) {
      sync.saveNow();
    }
  }

  function allQuestionIndices() {
    var indices = [];
    for (var index = 0; index < POOL_SIZE; index += 1) {
      indices.push(index);
    }
    return indices;
  }

  function questionIndexById(questionId) {
    var wanted = String(questionId);
    for (var index = 0; index < QUESTIONS.length; index += 1) {
      if (String(QUESTIONS[index].id) === wanted) {
        return index;
      }
    }
    return -1;
  }

  function stateForCloud(localState) {
    if (!localState) {
      return null;
    }

    var cloudState = clone(localState);

    function convertItems(candidate) {
      if (!candidate || !Array.isArray(candidate.items)) {
        return;
      }

      if (
        candidate.tracker &&
        Array.isArray(candidate.tracker.unusedIndices)
      ) {
        candidate.tracker.unusedIds =
          candidate.tracker.unusedIndices.map(function (questionIndex) {
            return QUESTIONS[questionIndex]
              ? QUESTIONS[questionIndex].id
              : null;
          }).filter(function (questionId) {
            return questionId !== null;
          });
        delete candidate.tracker.unusedIndices;
      }

      candidate.items = candidate.items.map(function (item) {
        var question = QUESTIONS[item.questionIndex];
        return {
          questionId: question ? question.id : item.questionId,
          cycleNumber: item.cycleNumber
        };
      });

      if (candidate.returnState) {
        convertItems(candidate.returnState);
      }
      if (candidate.mainSlot) {
        convertItems(candidate.mainSlot);
      }
      if (candidate.wrongSlot) {
        convertItems(candidate.wrongSlot);
      }
    }

    convertItems(cloudState);
    return cloudState;
  }

  function stateFromCloud(cloudState) {
    if (!cloudState) {
      return null;
    }

    var localState = clone(cloudState);

    function convertItems(candidate) {
      if (!candidate || !Array.isArray(candidate.items)) {
        return;
      }

      if (
        candidate.tracker &&
        !Array.isArray(candidate.tracker.unusedIndices) &&
        Array.isArray(candidate.tracker.unusedIds)
      ) {
        candidate.tracker.unusedIndices =
          candidate.tracker.unusedIds.map(questionIndexById)
            .filter(function (questionIndex) {
              return questionIndex >= 0;
            });
      }

      candidate.items = candidate.items.map(function (item) {
        if (typeof item.questionIndex === "number") {
          return item;
        }

        return {
          questionIndex: questionIndexById(item.questionId),
          cycleNumber: item.cycleNumber
        };
      });

      if (candidate.returnState) {
        convertItems(candidate.returnState);
      }
      if (candidate.mainSlot) {
        convertItems(candidate.mainSlot);
      }
      if (candidate.wrongSlot) {
        convertItems(candidate.wrongSlot);
      }
    }

    convertItems(localState);
    return localState;
  }

  function newTracker(cycleNumber) {
    return {
      cycleNumber: cycleNumber || 1,
      unusedIndices: shuffle(allQuestionIndices())
    };
  }

  function takeEligibleIndices(tracker, count, avoidMap) {
    var chosen = [];
    var remaining = [];

    tracker.unusedIndices.forEach(function (questionIndex) {
      if (
        chosen.length < count &&
        !avoidMap[String(questionIndex)]
      ) {
        chosen.push(questionIndex);
      } else {
        remaining.push(questionIndex);
      }
    });

    tracker.unusedIndices = remaining;
    return chosen;
  }

  function chooseMainItems(tracker) {
    var items = [];
    var selectedMap = {};

    while (items.length < MAIN_SESSION_SIZE) {
      if (!tracker.unusedIndices.length) {
        tracker.cycleNumber += 1;
        tracker.unusedIndices = shuffle(allQuestionIndices());
      }

      var cycleNumber = tracker.cycleNumber;
      var needed = MAIN_SESSION_SIZE - items.length;
      var chosen = takeEligibleIndices(
        tracker,
        needed,
        selectedMap
      );

      if (!chosen.length) {
        chosen = tracker.unusedIndices.splice(
          0,
          Math.min(needed, tracker.unusedIndices.length)
        );
      }

      chosen.forEach(function (questionIndex) {
        selectedMap[String(questionIndex)] = true;
        items.push({
          questionIndex: questionIndex,
          cycleNumber: cycleNumber
        });
      });
    }

    return shuffle(items);
  }

  function createOptionOrders(items) {
    var optionOrders = {};
    items.forEach(function (item) {
      var question = QUESTIONS[item.questionIndex];
      optionOrders[String(question.id)] = shuffle(
        question.options.map(function (option) {
          return option.letter;
        })
      );
    });
    return optionOrders;
  }

  function createMainState(existingTracker) {
    var tracker = existingTracker || newTracker(1);
    var items = chooseMainItems(tracker);

    return {
      version: 2,
      mode: "main",
      tracker: tracker,
      items: items,
      optionOrders: createOptionOrders(items),
      currentIndex: 0,
      selectedDisplayLetters: {},
      submitted: {},
      correct: {},
      paused: false,
      finished: false,
      historyRecorded: false,
      elapsedSeconds: 0,
      lastStartedAt: null,
      createdAt: Date.now(),
      sourceHistoryId: null,
      returnState: null
    };
  }

  function createWrongPracticeState(
    wrongQuestionIds,
    tracker,
    sourceHistoryId,
    returnState
  ) {
    var wanted = {};
    unique(wrongQuestionIds).forEach(function (questionId) {
      wanted[String(questionId)] = true;
    });

    var items = [];
    QUESTIONS.forEach(function (question, questionIndex) {
      if (wanted[String(question.id)]) {
        items.push({
          questionIndex: questionIndex,
          cycleNumber: tracker.cycleNumber
        });
      }
    });

    items = shuffle(items);

    return {
      version: 2,
      mode: "wrong",
      tracker: tracker,
      items: items,
      optionOrders: createOptionOrders(items),
      currentIndex: 0,
      selectedDisplayLetters: {},
      submitted: {},
      correct: {},
      paused: false,
      finished: false,
      historyRecorded: false,
      elapsedSeconds: 0,
      lastStartedAt: null,
      createdAt: Date.now(),
      sourceHistoryId: sourceHistoryId || null,
      returnState: returnState || null
    };
  }

  function validState(candidate) {
    if (!candidate || candidate.version !== 2) {
      return false;
    }
    if (candidate.mode !== "main" && candidate.mode !== "wrong") {
      return false;
    }
    if (!candidate.tracker || !Array.isArray(candidate.tracker.unusedIndices)) {
      return false;
    }
    if (!Array.isArray(candidate.items) || !candidate.items.length) {
      return false;
    }

    return candidate.items.every(function (item) {
      return (
        item &&
        typeof item.questionIndex === "number" &&
        item.questionIndex >= 0 &&
        item.questionIndex < POOL_SIZE
      );
    });
  }

  function repairState(candidate) {
    candidate.tracker.cycleNumber =
      candidate.tracker.cycleNumber || 1;
    candidate.optionOrders = candidate.optionOrders || {};

    candidate.items.forEach(function (item) {
      var question = QUESTIONS[item.questionIndex];
      var key = String(question.id);
      var validLetters = question.options
        .map(function (option) { return option.letter; })
        .sort()
        .join("|");
      var storedLetters = Array.isArray(candidate.optionOrders[key])
        ? candidate.optionOrders[key].slice().sort().join("|")
        : "";

      if (validLetters !== storedLetters) {
        candidate.optionOrders[key] = shuffle(
          question.options.map(function (option) {
            return option.letter;
          })
        );
      }
    });

    candidate.currentIndex =
      typeof candidate.currentIndex === "number" &&
      candidate.currentIndex >= 0 &&
      candidate.currentIndex < candidate.items.length
        ? candidate.currentIndex
        : 0;
    candidate.selectedDisplayLetters =
      candidate.selectedDisplayLetters || {};
    candidate.submitted = candidate.submitted || {};
    candidate.correct = candidate.correct || {};
    candidate.paused = !!candidate.paused;
    candidate.finished = !!candidate.finished;
    candidate.historyRecorded = !!candidate.historyRecorded;
    candidate.elapsedSeconds = candidate.elapsedSeconds || 0;
    candidate.lastStartedAt = null;
    candidate.sourceHistoryId = candidate.sourceHistoryId || null;

    if (candidate.returnState && !validState(candidate.returnState)) {
      candidate.returnState = null;
    }

    return candidate;
  }

  function loadState() {
    if (!storageAvailable) {
      return null;
    }

    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return null;
      }
      var parsed = JSON.parse(raw);
      return validState(parsed) ? repairState(parsed) : null;
    } catch (error) {
      return null;
    }
  }

  function saveState() {
    if (!storageAvailable || !state) {
      return;
    }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      touchLocalUpdatedAt();
      queueCloudSave();
    } catch (error) {}
  }

  function loadHistory() {
    if (!storageAvailable) {
      return [];
    }

    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    } catch (error) {
      return [];
    }
  }

  function mainOnlyHistory(history) {
    return (history || []).filter(function (entry) {
      return entry && entry.mode !== "wrong";
    });
  }

  function entryScore(entry) {
    var keys = 0;
    for (var key in entry) {
      if (
        Object.prototype.hasOwnProperty.call(entry, key) &&
        entry[key] !== null &&
        entry[key] !== undefined &&
        entry[key] !== ""
      ) {
        keys += 1;
      }
    }
    return keys;
  }

  function preferEntry(existing, incoming) {
    if (!existing) {
      return incoming;
    }
    if (!incoming) {
      return existing;
    }

    var existingTs = Number(existing.timestamp) || 0;
    var incomingTs = Number(incoming.timestamp) || 0;

    if (incomingTs !== existingTs) {
      return incomingTs > existingTs ? incoming : existing;
    }

    return entryScore(incoming) > entryScore(existing) ? incoming : existing;
  }

  function mergeHistory(localHistory, remoteHistory) {
    var byId = {};
    var noId = [];

    function absorb(history) {
      (history || []).forEach(function (entry) {
        if (!entry || entry.mode === "wrong") {
          return;
        }
        if (!entry.id) {
          noId.push(entry);
          return;
        }
        var key = String(entry.id);
        byId[key] = preferEntry(byId[key], entry);
      });
    }

    absorb(localHistory);
    absorb(remoteHistory);

    var merged = noId.slice();
    Object.keys(byId).forEach(function (key) {
      merged.push(byId[key]);
    });

    merged.sort(function (a, b) {
      return (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0);
    });

    return merged;
  }

  function saveHistory(history) {
    if (!storageAvailable) {
      return;
    }

    try {
      localStorage.setItem(
        HISTORY_KEY,
        JSON.stringify(history.slice(-120))
      );
      touchLocalUpdatedAt();
      queueCloudSave();
    } catch (error) {}
  }

  function writeStateAndHistory(nextState, nextHistory, updatedAtMs) {
    applyingRemote = true;

    try {
      state = repairState(nextState);
      if (storageAvailable) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        localStorage.setItem(
          HISTORY_KEY,
          JSON.stringify(mainOnlyHistory(nextHistory).slice(-120))
        );
      }
      setLocalUpdatedAt(updatedAtMs);
    } finally {
      applyingRemote = false;
    }
  }

  function currentItem() {
    return state.items[state.currentIndex];
  }

  function currentQuestion() {
    return QUESTIONS[currentItem().questionIndex];
  }

  function displayedOptions(question) {
    var originalOrder =
      state.optionOrders[String(question.id)] ||
      question.options.map(function (option) {
        return option.letter;
      });

    return originalOrder
      .map(function (originalLetter, displayIndex) {
        var originalOption = question.options.find(function (option) {
          return option.letter === originalLetter;
        });

        return {
          displayLetter: DISPLAY_LETTERS[displayIndex],
          originalLetter: originalLetter,
          text: originalOption ? originalOption.text : ""
        };
      })
      .filter(function (option) {
        return option.text;
      });
  }

  function correctDisplayedLetters(question) {
    var map = {};
    displayedOptions(question).forEach(function (option) {
      map[option.originalLetter] = option.displayLetter;
    });

    return question.correct
      .map(function (originalLetter) {
        return map[originalLetter];
      })
      .filter(Boolean)
      .sort();
  }

  function selectedLetters(questionId) {
    return state.selectedDisplayLetters[String(questionId)] || [];
  }

  function sameSet(left, right) {
    return left.slice().sort().join("|") ===
      right.slice().sort().join("|");
  }

  function displayedAnswerText(question, displayedLetters) {
    var options = displayedOptions(question);

    return displayedLetters
      .slice()
      .sort()
      .map(function (displayLetter) {
        var option = options.find(function (candidate) {
          return candidate.displayLetter === displayLetter;
        });

        return option
          ? displayLetter + ". " + option.text
          : displayLetter;
      })
      .join("\n");
  }

  function answeredCount() {
    return Object.keys(state.submitted).length;
  }

  function correctCount() {
    return Object.keys(state.correct).reduce(function (total, key) {
      return total + (state.correct[key] ? 1 : 0);
    }, 0);
  }

  function wrongQuestionIds() {
    var wrongIds = [];

    state.items.forEach(function (item) {
      var question = QUESTIONS[item.questionIndex];
      var key = String(question.id);

      if (state.submitted[key] && !state.correct[key]) {
        wrongIds.push(question.id);
      }
    });

    return unique(wrongIds);
  }

  function cyclesTouched() {
    return unique(
      state.items.map(function (item) {
        return item.cycleNumber;
      })
    );
  }

  function renderSyncStatus(status) {
    if (!ui.syncStatus) {
      return;
    }

    var text = status || "Offline";
    ui.syncStatus.textContent = text;
    ui.syncStatus.className = "sync-status";

    if (text === "Saving") {
      ui.syncStatus.classList.add("saving");
    } else if (text === "Saved") {
      ui.syncStatus.classList.add("saved");
    } else if (text === "Sync error") {
      ui.syncStatus.classList.add("error");
    }

    if (ui.pauseSavedText) {
      ui.pauseSavedText.textContent =
        sync && sync.user
          ? "Your progress has been saved for cloud sync."
          : "Your progress has been saved on this device.";
    }
  }

  function renderAuth() {
    var signedIn = !!(sync && sync.user);

    if (ui.authUser) {
      ui.authUser.textContent =
        signedIn && sync.user.email
          ? sync.user.email
          : "Local-only mode";
    }

    if (ui.authEmail) {
      ui.authEmail.classList.toggle("hidden", signedIn);
    }
    if (ui.authPassword) {
      ui.authPassword.classList.toggle("hidden", signedIn);
    }
    if (ui.authLoginBtn) {
      ui.authLoginBtn.classList.toggle("hidden", signedIn);
    }
    if (ui.authSignUpBtn) {
      ui.authSignUpBtn.classList.toggle("hidden", signedIn);
    }
    if (ui.authResetBtn) {
      ui.authResetBtn.classList.toggle("hidden", signedIn);
    }
    if (ui.authLogoutBtn) {
      ui.authLogoutBtn.classList.toggle("hidden", !signedIn);
    }
  }

  function refreshCurrentView() {
    if (state.finished) {
      showResults();
    } else if (currentView === "quiz") {
      switchView("quiz");
      renderQuestion();
      startTimer();
    } else if (state.paused) {
      switchView("paused");
    } else {
      switchView("intro");
    }
  }

  function applyRemotePayload(payload) {
    var remoteState = payload && payload.state
      ? stateFromCloud(payload.state)
      : null;

    if (!payload || !remoteState || !validState(remoteState)) {
      if (sync && sync.user) {
        sync.queueSave();
      }
      return;
    }

    if (
      localUpdatedAt &&
      payload.updatedAtMs &&
      localUpdatedAt > payload.updatedAtMs
    ) {
      sync.queueSave();
      return;
    }

    applyingRemote = true;
    stopTimer();
    applyingRemote = false;

    writeStateAndHistory(
      remoteState,
      mergeHistory(
        loadHistory(),
        Array.isArray(payload.history) ? payload.history : []
      ),
      payload.updatedAtMs
    );
    refreshCurrentView();
    renderCycleStatus();
    renderHistory();
    renderSyncStatus("Saved");
  }

  function persistLocalHistory(history) {
    if (!storageAvailable) {
      return;
    }
    try {
      localStorage.setItem(
        HISTORY_KEY,
        JSON.stringify(mainOnlyHistory(history).slice(-120))
      );
    } catch (error) {}
  }

  function historyMigrated() {
    if (!storageAvailable) {
      return false;
    }
    return localStorage.getItem(HISTORY_MIGRATED_KEY) === "1";
  }

  function markHistoryMigrated() {
    if (!storageAvailable) {
      return;
    }
    try {
      localStorage.setItem(HISTORY_MIGRATED_KEY, "1");
    } catch (error) {}
  }

  // Pull append-only quiz_history rows, merge into local cache, and
  // one-time migrate pre-existing local (quiz_progress-sourced) entries up.
  function syncHistoryRows() {
    if (!sync || !sync.user || !sync.loadHistoryRows) {
      return Promise.resolve();
    }

    return sync
      .loadHistoryRows()
      .then(function (rows) {
        var localHistory = loadHistory();
        var merged = mergeHistory(localHistory, rows);
        persistLocalHistory(merged);
        renderHistory();

        if (!historyMigrated() && sync.saveHistoryEntries) {
          return sync
            .saveHistoryEntries(mainOnlyHistory(merged))
            .then(function () {
              markHistoryMigrated();
            })
            .catch(function () {});
        }
        return null;
      })
      .catch(function () {});
  }

  function authValues() {
    return {
      email: ui.authEmail ? ui.authEmail.value.trim() : "",
      password: ui.authPassword ? ui.authPassword.value : ""
    };
  }

  function handleAuthError(result) {
    if (result && result.error) {
      renderSyncStatus("Sync error");
      window.alert(result.error.message || "Authentication failed.");
      return true;
    }
    return false;
  }

  function initCloudSync() {
    if (!window.QuizSupabaseSync) {
      renderSyncStatus("Offline");
      renderAuth();
      return;
    }

    sync = window.QuizSupabaseSync.create();
    if (sync.setHistoryMerger) {
      sync.setHistoryMerger(function (cloudHistory, localHistory) {
        return mergeHistory(localHistory, cloudHistory);
      });
    }
    sync.onStatusChange(function (status) {
      renderSyncStatus(status);
      renderAuth();
    });
    sync.onRemoteChange(function (payload) {
      applyRemotePayload(payload);
      syncHistoryRows();
      renderAuth();
    });
    sync
      .init(syncPayload)
      .then(function () {
        renderAuth();
        if (sync.user) {
          return sync
            .loadRemote()
            .then(function (remote) {
              applyRemotePayload(remote ? remote.payload : null);
            })
            .then(function () {
              return syncHistoryRows();
            });
        }
        return null;
      })
      .catch(function () {
        renderSyncStatus("Sync error");
      });
  }

  function signUp() {
    var values = authValues();
    if (!values.email || !values.password) {
      window.alert("Enter email and password.");
      return;
    }

    renderSyncStatus("Saving");
    sync.signUp(values.email, values.password).then(function (result) {
      if (!handleAuthError(result)) {
        window.alert("Check your email to confirm sign-up if required.");
      }
    }).catch(function (error) {
      handleAuthError({ error: error });
    });
  }

  function login() {
    var values = authValues();
    if (!values.email || !values.password) {
      window.alert("Enter email and password.");
      return;
    }

    renderSyncStatus("Saving");
    sync.login(values.email, values.password)
      .then(handleAuthError)
      .catch(function (error) {
        handleAuthError({ error: error });
      });
  }

  function logout() {
    if (!sync) {
      return;
    }

    flushCloudSave();
    sync.logout()
      .then(function (result) {
        handleAuthError(result);
        renderAuth();
        renderSyncStatus("Offline");
      })
      .catch(function (error) {
        handleAuthError({ error: error });
      });
  }

  function resetPassword() {
    var values = authValues();
    if (!values.email) {
      window.alert("Enter your email first.");
      return;
    }

    renderSyncStatus("Saving");
    sync.resetPassword(values.email).then(function (result) {
      if (!handleAuthError(result)) {
        renderSyncStatus("Saved");
        window.alert("Password reset email sent.");
      }
    }).catch(function (error) {
      handleAuthError({ error: error });
    });
  }

  function switchView(view) {
    currentView = view;
    ui.introCard.classList.toggle("hidden", view !== "intro");
    ui.pausedCard.classList.toggle("hidden", view !== "paused");
    ui.quizArea.classList.toggle("hidden", view !== "quiz");
    ui.resultsCard.classList.toggle("hidden", view !== "results");
    ui.pauseTopBtn.disabled = view !== "quiz";

    updateSessionSwitchButtons();

    renderCycleStatus();
    renderHistory();
  }

  // Inside a wrong-practice session, expose "Resume Main Session" (restore the
  // saved main slot exactly) and "Start Next Main Session". Both appear on the
  // in-quiz actions and on the paused wrong-practice screen.
  function updateSessionSwitchButtons() {
    var inWrong = state.mode === "wrong";
    var canResumeMain = inWrong && !!(state.mainSlot || state.returnState);

    // In-quiz buttons (only while actively in the wrong-practice quiz view).
    var showInQuiz = inWrong && currentView === "quiz";
    if (ui.resumeMainQuizBtn) {
      ui.resumeMainQuizBtn.classList.toggle(
        "hidden",
        !(showInQuiz && canResumeMain)
      );
    }
    if (ui.nextMainQuizBtn) {
      ui.nextMainQuizBtn.classList.toggle("hidden", !showInQuiz);
    }

    // Paused-screen buttons (only while the paused screen shows a wrong session).
    var showPaused = inWrong && currentView === "paused";
    if (ui.returnFromPauseBtn) {
      ui.returnFromPauseBtn.classList.toggle(
        "hidden",
        !(showPaused && canResumeMain)
      );
    }
    if (ui.nextMainPausedBtn) {
      ui.nextMainPausedBtn.classList.toggle("hidden", !showPaused);
    }

    // Resume saved wrong-practice from the main session (exact position).
    var canResumeWrong = state.mode === "main" && !!state.wrongSlot;
    if (ui.resumeWrongIntroBtn) {
      ui.resumeWrongIntroBtn.classList.toggle(
        "hidden",
        !(canResumeWrong && currentView === "intro")
      );
    }
    if (ui.resumeWrongQuizBtn) {
      ui.resumeWrongQuizBtn.classList.toggle(
        "hidden",
        !(canResumeWrong && currentView === "quiz")
      );
    }
  }

  function stopTimer() {
    if (timerHandle) {
      clearInterval(timerHandle);
    }
    timerHandle = null;

    if (
      state &&
      state.lastStartedAt &&
      !state.paused &&
      !state.finished
    ) {
      var extraSeconds = Math.floor(
        (Date.now() - state.lastStartedAt) / 1000
      );
      if (extraSeconds > 0) {
        state.elapsedSeconds += extraSeconds;
      }
    }

    if (state) {
      state.lastStartedAt = null;
    }

    saveState();
  }

  function startTimer() {
    stopTimer();

    if (!state.paused && !state.finished) {
      state.lastStartedAt = Date.now();
      saveState();
      timerHandle = setInterval(updateStats, 1000);
    }
  }

  function elapsedSeconds() {
    var total = state.elapsedSeconds || 0;

    if (
      state.lastStartedAt &&
      !state.paused &&
      !state.finished
    ) {
      total += Math.floor(
        (Date.now() - state.lastStartedAt) / 1000
      );
    }

    return total;
  }

  function formatTime(seconds) {
    var total = Number(seconds) || 0;
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var remaining = total % 60;

    function pad(number) {
      return String(number).padStart(2, "0");
    }

    return hours > 0
      ? pad(hours) + ":" + pad(minutes) + ":" + pad(remaining)
      : pad(minutes) + ":" + pad(remaining);
  }

  function renderQuestion() {
    var item = currentItem();
    var question = currentQuestion();
    var key = String(question.id);
    var selected = selectedLetters(question.id);
    var submitted = !!state.submitted[key];
    var correctLetters = correctDisplayedLetters(question);
    var modeText =
      state.mode === "wrong"
        ? "Wrong Practice"
        : "Main Session";

    ui.statMode.textContent =
      state.mode === "wrong" ? "Wrong" : "Main";
    ui.sessionPosition.textContent =
      modeText +
      " question " +
      (state.currentIndex + 1) +
      " of " +
      state.items.length;
    ui.sourceQuestion.textContent =
      "Source Question #" + question.id;
    ui.cycleBadge.textContent =
      state.mode === "main"
        ? "Cycle " + item.cycleNumber
        : "Practice";
    ui.questionText.textContent = question.prompt;
    ui.multiHint.classList.toggle("hidden", !question.multi);
    ui.options.innerHTML = "";

    displayedOptions(question).forEach(function (option) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "option-btn";

      var letter = document.createElement("span");
      letter.className = "option-letter";
      letter.textContent = option.displayLetter;

      var text = document.createElement("span");
      text.textContent = option.text;

      button.appendChild(letter);
      button.appendChild(text);

      if (selected.indexOf(option.displayLetter) !== -1) {
        button.classList.add("selected");
      }

      if (submitted) {
        if (correctLetters.indexOf(option.displayLetter) !== -1) {
          button.classList.add("correct");
        }

        if (
          selected.indexOf(option.displayLetter) !== -1 &&
          correctLetters.indexOf(option.displayLetter) === -1
        ) {
          button.classList.add("wrong");
        }
      }

      button.addEventListener("click", function () {
        selectOption(question, option.displayLetter);
      });

      ui.options.appendChild(button);
    });

    if (submitted) {
      var isCorrect = !!state.correct[key];
      ui.feedback.className =
        "feedback show " + (isCorrect ? "good" : "bad");

      if (isCorrect) {
        ui.feedback.textContent =
          "Correct.\n\nAnswer: " +
          correctLetters.join(", ") +
          "\n" +
          displayedAnswerText(question, correctLetters);
      } else {
        ui.feedback.textContent =
          "Wrong.\n\nYour answer: " +
          (selected.length
            ? selected.slice().sort().join(", ")
            : "No answer") +
          "\n\nCorrect answer: " +
          correctLetters.join(", ") +
          "\n" +
          displayedAnswerText(question, correctLetters);
      }

      ui.submitBtn.classList.add("hidden");
      ui.nextBtn.classList.remove("hidden");
      ui.nextBtn.textContent =
        state.currentIndex === state.items.length - 1
          ? "Finish Session"
          : "Next";
    } else {
      ui.feedback.className = "feedback";
      ui.feedback.textContent = "";
      ui.submitBtn.classList.remove("hidden");
      ui.nextBtn.classList.add("hidden");
    }

    ui.previousBtn.disabled = state.currentIndex === 0;
    updateStats();
    saveState();
  }

  function selectOption(question, displayLetter) {
    var key = String(question.id);

    if (state.submitted[key]) {
      return;
    }

    var selected = selectedLetters(question.id).slice();

    if (question.multi) {
      var existingIndex = selected.indexOf(displayLetter);
      if (existingIndex >= 0) {
        selected.splice(existingIndex, 1);
      } else {
        selected.push(displayLetter);
      }
    } else {
      selected = [displayLetter];
    }

    state.selectedDisplayLetters[key] = selected.sort();
    saveState();
    renderQuestion();
  }

  function submitAnswer() {
    var question = currentQuestion();
    var key = String(question.id);
    var selected = selectedLetters(question.id);

    if (!selected.length) {
      ui.feedback.className = "feedback show bad";
      ui.feedback.textContent =
        "Choose an answer before submitting.";
      return;
    }

    state.submitted[key] = true;
    state.correct[key] = sameSet(
      selected,
      correctDisplayedLetters(question)
    );

    saveState();
    renderQuestion();
  }

  function nextQuestion() {
    if (state.currentIndex < state.items.length - 1) {
      state.currentIndex += 1;
      saveState();
      renderQuestion();
      window.scrollTo(0, 0);
    } else {
      finishSession();
    }
  }

  function previousQuestion() {
    if (state.currentIndex > 0) {
      state.currentIndex -= 1;
      saveState();
      renderQuestion();
      window.scrollTo(0, 0);
    }
  }

  function updateStats() {
    var answered = answeredCount();
    var correct = correctCount();
    var wrong = answered - correct;

    ui.statProgress.textContent =
      answered + "/" + state.items.length;
    ui.statCorrect.textContent = correct;
    ui.statWrong.textContent = wrong;
    ui.statTime.textContent = formatTime(elapsedSeconds());
    ui.progressBar.style.width =
      Math.round((answered / state.items.length) * 100) + "%";
  }

  function createHistoryId() {
    return (
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 9)
    );
  }

  function addHistoryEntry() {
    if (state.mode !== "main") {
      return null;
    }

    if (state.historyRecorded) {
      return null;
    }

    var history = loadHistory();
    var total = state.items.length;
    var correct = correctCount();
    var wrongIds = wrongQuestionIds();

    var entry = {
      id: createHistoryId(),
      timestamp: Date.now(),
      date: new Date().toLocaleString(),
      mode: state.mode,
      cycles: cyclesTouched(),
      sourceHistoryId: state.sourceHistoryId || null,
      total: total,
      correct: correct,
      wrong: wrongIds.length,
      percentage: total
        ? Math.round((correct / total) * 100)
        : 0,
      elapsedSeconds: elapsedSeconds(),
      questionIds: state.items.map(function (item) {
        return QUESTIONS[item.questionIndex].id;
      }),
      wrongIds: wrongIds
    };

    history.push(entry);

    saveHistory(history);
    state.historyRecorded = true;
    return entry;
  }

  function finishSession() {
    stopTimer();
    state.finished = true;
    state.paused = false;
    var entry = addHistoryEntry();
    saveState();
    flushCloudSave();
    if (entry && sync && sync.user && sync.saveHistoryEntry) {
      sync.saveHistoryEntry(entry).catch(function () {});
    }
    showResults();
  }

  function showResults() {
    stopTimer();

    var total = state.items.length;
    var correct = correctCount();
    var wrongIds = wrongQuestionIds();
    var percentage = total
      ? Math.round((correct / total) * 100)
      : 0;

    ui.resultsTitle.textContent =
      state.mode === "wrong"
        ? "Wrong-Answer Practice Finished"
        : "Main Session Finished";
    ui.finalScore.textContent = correct + "/" + total;
    ui.finalPercentage.textContent = percentage + "%";
    ui.finalWrong.textContent = wrongIds.length;
    ui.finalTime.textContent = formatTime(elapsedSeconds());

    ui.wrongRetestBtn.classList.add("hidden");

    if (wrongIds.length) {
      ui.resultsNote.textContent =
        "This session has " +
        wrongIds.length +
        " wrong question(s). You can practice them now, retest any remaining wrong answers again, or reopen this wrong set later from Session History.";

      ui.wrongRetestBtn.textContent =
        state.mode === "wrong"
          ? "Practice Remaining Wrong Answers Again"
          : "Start Wrong-Answer Short Test";
      ui.wrongRetestBtn.classList.remove("hidden");
    } else if (state.mode === "wrong") {
      ui.resultsNote.textContent =
        "You corrected every question in this practice session.";
    } else {
      ui.resultsNote.textContent =
        "Perfect session. No wrong-answer practice is needed.";
    }

    ui.returnToPreviousBtn.classList.toggle(
      "hidden",
      !(state.mainSlot || state.returnState)
    );

    switchView("results");
    renderReview(false);
  }

  function continueCurrent() {
    if (state.finished) {
      showResults();
      return;
    }

    if (state.paused) {
      switchView("paused");
      return;
    }

    switchView("quiz");
    renderQuestion();
    startTimer();
  }

  function pauseQuiz() {
    stopTimer();
    state.paused = true;
    saveState();
    flushCloudSave();
    switchView("paused");
  }

  function resumeQuiz() {
    state.paused = false;
    state.finished = false;
    saveState();
    switchView("quiz");
    renderQuestion();
    startTimer();
  }

  function canReplaceCurrentMain() {
    if (state.mode !== "main" || state.finished) {
      return true;
    }

    window.alert(
      "Finish the current main session before starting the next one. This prevents unused questions from being skipped in the no-repeat cycle."
    );
    return false;
  }

  // Strip the saved-slot sidecars (and live timer) from a state so we can
  // store it inside another state's slot without nesting slots recursively.
  function detachSlots(source) {
    var snapshot = clone(source);
    snapshot.lastStartedAt = null;
    snapshot.returnState = null;
    delete snapshot.mainSlot;
    delete snapshot.wrongSlot;
    return snapshot;
  }

  function startNextMainSession() {
    if (!canReplaceCurrentMain()) {
      return;
    }

    stopTimer();

    // Preserve any saved wrong-practice session across the new main session.
    var savedWrong =
      state.mode === "wrong"
        ? detachSlots(state)
        : (state.wrongSlot ? clone(state.wrongSlot) : null);

    state = createMainState(state.tracker);
    if (savedWrong) {
      state.wrongSlot = savedWrong;
    }

    saveState();
    ui.reviewArea.classList.add("hidden");
    switchView("quiz");
    renderQuestion();
    startTimer();
    window.scrollTo(0, 0);
  }

  function startWrongPractice(
    wrongIds,
    sourceHistoryId,
    preserveCurrent
  ) {
    wrongIds = unique(wrongIds || []);

    if (!wrongIds.length) {
      window.alert("This session has no wrong questions to practice.");
      return;
    }

    stopTimer();

    // Capture the main session to its slot so it can be resumed exactly.
    var savedMain = null;
    if (preserveCurrent && state.mode === "main" && !state.finished) {
      savedMain = detachSlots(state);
    } else if (state.mainSlot) {
      savedMain = clone(state.mainSlot);
    }

    state = createWrongPracticeState(
      wrongIds,
      state.tracker,
      sourceHistoryId,
      null
    );
    if (savedMain) {
      state.mainSlot = savedMain;
    }

    saveState();
    ui.reviewArea.classList.add("hidden");
    switchView("quiz");
    renderQuestion();
    startTimer();
    window.scrollTo(0, 0);
  }

  function startCurrentWrongPractice() {
    startWrongPractice(
      wrongQuestionIds(),
      null,
      false
    );
  }

  function startHistoricalWrongPractice(historyId) {
    var history = loadHistory();
    var entry = history.find(function (candidate) {
      return candidate.id === historyId;
    });

    if (!entry || !entry.wrongIds || !entry.wrongIds.length) {
      window.alert("No saved wrong questions were found for this session.");
      return;
    }

    startWrongPractice(
      entry.wrongIds,
      entry.id,
      !state.finished
    );
  }

  // Resume the saved main session from inside a wrong-practice session,
  // while keeping the current wrong-practice session saved separately.
  function resumeMainSession() {
    if (!state.mainSlot) {
      return;
    }

    stopTimer();

    var savedWrong =
      state.mode === "wrong" ? detachSlots(state) : null;

    state = repairState(clone(state.mainSlot));
    if (savedWrong) {
      state.wrongSlot = savedWrong;
    }

    saveState();

    if (state.finished) {
      showResults();
    } else if (state.paused) {
      switchView("paused");
    } else {
      switchView("quiz");
      renderQuestion();
      startTimer();
    }
  }

  // Resume the saved wrong-practice session (from the main session) at its
  // exact saved position, keeping the current main session saved separately.
  function resumeWrongSession() {
    if (!state.wrongSlot) {
      return;
    }

    stopTimer();

    var savedMain =
      state.mode === "main" ? detachSlots(state) : null;

    state = repairState(clone(state.wrongSlot));
    if (savedMain) {
      state.mainSlot = savedMain;
    }

    saveState();

    if (state.finished) {
      showResults();
    } else if (state.paused) {
      switchView("paused");
    } else {
      switchView("quiz");
      renderQuestion();
      startTimer();
    }
  }

  // Backwards-compatible: older states used a single embedded returnState.
  function returnToPreviousSession() {
    if (state.mainSlot) {
      resumeMainSession();
      return;
    }

    if (!state.returnState) {
      return;
    }

    stopTimer();
    state = repairState(clone(state.returnState));
    state.returnState = null;
    saveState();

    if (state.finished) {
      showResults();
    } else if (state.paused) {
      switchView("paused");
    } else {
      switchView("quiz");
      renderQuestion();
      startTimer();
    }
  }

  function resetAll() {
    var confirmed = window.confirm(
      "Reset the current session, cycle progress, all wrong-answer practice data, and all session history?"
    );

    if (!confirmed) {
      return;
    }

    stopTimer();

    if (storageAvailable) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(HISTORY_KEY);
      localStorage.removeItem(SYNC_META_KEY);
    }

    state = createMainState(newTracker(1));
    saveState();
    switchView("intro");
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, function (character) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;"
      }[character];
    });
  }

  function renderReview(toggleVisibility) {
    ui.reviewArea.innerHTML =
      "<h3>Review</h3>" +
      "<p class=\"small\">The answer letters below match the shuffled displayed option order from this session.</p>";

    state.items.forEach(function (item, position) {
      var question = QUESTIONS[item.questionIndex];
      var selected = selectedLetters(question.id);
      var correctLetters = correctDisplayedLetters(question);
      var isCorrect = !!state.correct[String(question.id)];
      var reviewItem = document.createElement("div");

      reviewItem.className =
        "review-item " + (isCorrect ? "correct" : "wrong");

      reviewItem.innerHTML =
        "<div class=\"small\">" +
        (state.mode === "wrong"
          ? "Wrong Practice"
          : "Main Session") +
        " question " +
        (position + 1) +
        " of " +
        state.items.length +
        " · Source Question #" +
        question.id +
        "</div>" +
        "<div class=\"review-question\">" +
        escapeHtml(question.prompt) +
        "</div>" +
        "<p><span class=\"answer-pill\">Your: " +
        escapeHtml(
          selected.length
            ? selected.slice().sort().join(", ")
            : "No answer"
        ) +
        "</span> <span class=\"answer-pill\">Correct: " +
        escapeHtml(correctLetters.join(", ")) +
        "</span></p>" +
        "<pre class=\"small\">" +
        escapeHtml(
          displayedAnswerText(question, correctLetters)
        ) +
        "</pre>";

      ui.reviewArea.appendChild(reviewItem);
    });

    if (toggleVisibility) {
      ui.reviewArea.classList.toggle("hidden");
    }
  }

  function renderCycleStatus() {
    if (!state || !ui.cycleStatus) {
      return;
    }

    var remaining = state.tracker.unusedIndices.length;
    var used = POOL_SIZE - remaining;
    var touched = cyclesTouched().join(" + ");
    var text =
      "Current cycle: " +
      state.tracker.cycleNumber +
      " · Questions already assigned in this cycle: " +
      used +
      "/" +
      POOL_SIZE +
      " · Unused questions remaining: " +
      remaining +
      ".";

    if (state.mode === "main" && cyclesTouched().length > 1) {
      text +=
        " This session crosses cycle " +
        touched +
        " because the previous cycle ran out.";
    }

    ui.cycleStatus.textContent = text;

    var currentWrong =
      state.finished ? wrongQuestionIds() : [];

    ui.currentWrongBtn.classList.toggle(
      "hidden",
      !state.finished || !currentWrong.length
    );
  }

  function historyModeLabel(entry) {
    return entry.mode === "wrong"
      ? "Wrong Practice"
      : "Main Session";
  }

  function renderHistory() {
    if (!ui.historyBar || !ui.historyList) {
      return;
    }

    var history = loadHistory();
    ui.historyBar.innerHTML = "";
    ui.historyList.innerHTML = "";

    if (!history.length) {
      ui.historyList.textContent =
        "No completed sessions yet.";
      return;
    }

    history.slice(-14).forEach(function (entry) {
      var pill = document.createElement("div");
      pill.className =
        "history-pill " +
        (entry.percentage >= 70 ? "good" : "bad");
      pill.textContent =
        (entry.mode === "wrong" ? "Wrong " : "Main ") +
        entry.correct +
        "/" +
        entry.total +
        " (" +
        entry.percentage +
        "%)";
      ui.historyBar.appendChild(pill);
    });

    history
      .slice()
      .reverse()
      .slice(0, 60)
      .forEach(function (entry) {
        var card = document.createElement("article");
        card.className = "history-card";

        var cycleText =
          entry.cycles && entry.cycles.length
            ? entry.cycles.join(" + ")
            : "-";

        var wrongList =
          entry.wrongIds && entry.wrongIds.length
            ? entry.wrongIds
                .map(function (questionId) {
                  return "#" + questionId;
                })
                .join(", ")
            : "None";

        card.innerHTML =
          "<div class=\"history-card-head\">" +
            "<div>" +
              "<h3 class=\"history-title\">" +
                escapeHtml(historyModeLabel(entry)) +
              "</h3>" +
              "<div class=\"small\">" +
                escapeHtml(entry.date) +
                " · Cycle " +
                escapeHtml(cycleText) +
                " · " +
                formatTime(entry.elapsedSeconds || 0) +
              "</div>" +
            "</div>" +
            "<div class=\"history-score\">" +
              entry.correct +
              "/" +
              entry.total +
              " · " +
              entry.percentage +
              "%" +
            "</div>" +
          "</div>" +
          "<div class=\"history-wrong-list\">" +
            "Wrong questions (" +
            entry.wrong +
            "): " +
            escapeHtml(wrongList) +
          "</div>";

        if (entry.wrongIds && entry.wrongIds.length) {
          var practiceButton = document.createElement("button");
          practiceButton.type = "button";
          practiceButton.className =
            "primary history-practice-btn";
          practiceButton.textContent =
            "Practice These " +
            entry.wrongIds.length +
            " Wrong Questions";
          practiceButton.setAttribute(
            "data-history-practice",
            entry.id
          );
          card.appendChild(practiceButton);
        }

        ui.historyList.appendChild(card);
      });
  }

  function clearHistory() {
    var confirmed = window.confirm(
      "Clear all session history and its saved wrong-answer practice lists?"
    );

    if (!confirmed) {
      return;
    }

    saveHistory([]);

    renderHistory();
  }

  function handleHistoryClick(event) {
    var button = event.target.closest(
      "[data-history-practice]"
    );

    if (!button) {
      return;
    }

    startHistoricalWrongPractice(
      button.getAttribute("data-history-practice")
    );
  }

  // Theme toggle is handled by a self-contained module in index.html's
  // <head> so it binds reliably in Safari standalone, independent of quiz boot.

  function addHandlers() {
    ui.continueBtn.addEventListener(
      "click",
      continueCurrent
    );
    ui.newMainBtn.addEventListener(
      "click",
      startNextMainSession
    );
    ui.currentWrongBtn.addEventListener(
      "click",
      startCurrentWrongPractice
    );
    ui.resetAllBtn.addEventListener(
      "click",
      resetAll
    );
    ui.pauseTopBtn.addEventListener(
      "click",
      pauseQuiz
    );
    ui.pauseBtn.addEventListener(
      "click",
      pauseQuiz
    );
    ui.resumeBtn.addEventListener(
      "click",
      resumeQuiz
    );
    ui.returnFromPauseBtn.addEventListener(
      "click",
      returnToPreviousSession
    );
    if (ui.resumeMainQuizBtn) {
      ui.resumeMainQuizBtn.addEventListener("click", resumeMainSession);
    }
    if (ui.nextMainQuizBtn) {
      ui.nextMainQuizBtn.addEventListener("click", startNextMainSession);
    }
    if (ui.nextMainPausedBtn) {
      ui.nextMainPausedBtn.addEventListener("click", startNextMainSession);
    }
    if (ui.resumeWrongIntroBtn) {
      ui.resumeWrongIntroBtn.addEventListener("click", resumeWrongSession);
    }
    if (ui.resumeWrongQuizBtn) {
      ui.resumeWrongQuizBtn.addEventListener("click", resumeWrongSession);
    }
    ui.previousBtn.addEventListener(
      "click",
      previousQuestion
    );
    ui.submitBtn.addEventListener(
      "click",
      submitAnswer
    );
    ui.nextBtn.addEventListener(
      "click",
      nextQuestion
    );
    ui.wrongRetestBtn.addEventListener(
      "click",
      startCurrentWrongPractice
    );
    ui.reviewBtn.addEventListener(
      "click",
      function () {
        renderReview(true);
      }
    );
    ui.nextMainResultsBtn.addEventListener(
      "click",
      startNextMainSession
    );
    ui.returnToPreviousBtn.addEventListener(
      "click",
      returnToPreviousSession
    );
    ui.clearHistoryBtn.addEventListener(
      "click",
      clearHistory
    );
    ui.historyList.addEventListener(
      "click",
      handleHistoryClick
    );
    if (ui.authSignUpBtn) {
      ui.authSignUpBtn.addEventListener("click", signUp);
    }
    if (ui.authLoginBtn) {
      ui.authLoginBtn.addEventListener("click", login);
    }
    if (ui.authLogoutBtn) {
      ui.authLogoutBtn.addEventListener("click", logout);
    }
    if (ui.authResetBtn) {
      ui.authResetBtn.addEventListener("click", resetPassword);
    }

    window.addEventListener("beforeunload", function () {
      stopTimer();
      saveState();
      if (sync && sync.user) {
        sync.saveNow();
      }
    });
    window.addEventListener("pagehide", function () {
      stopTimer();
      saveState();
      if (sync && sync.user) {
        sync.saveNow();
      }
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") {
        stopTimer();
        saveState();
        if (sync && sync.user) {
          sync.saveNow();
        }
      }
    });
  }

  function boot() {
    cacheElements();

    if (POOL_SIZE !== 684) {
      ui.diagnostic.classList.remove("hidden");
      ui.diagnostic.textContent =
        "Question data problem: expected 684 questions, found " +
        POOL_SIZE +
        ".";
      return;
    }

    state = loadState() || createMainState(newTracker(1));

    var existingHistory = loadHistory();
    var cleanedHistory = mainOnlyHistory(existingHistory);
    if (cleanedHistory.length !== existingHistory.length && storageAvailable) {
      try {
        localStorage.setItem(
          HISTORY_KEY,
          JSON.stringify(cleanedHistory.slice(-120))
        );
      } catch (error) {}
    }

    var meta = readMeta();
    localUpdatedAt =
      meta.updatedAtMs || inferredLocalUpdatedAt(loadHistory());
    writeMeta({
      updatedAtMs: localUpdatedAt,
      clientId: clientId()
    });
    ui.diagnostic.classList.add("hidden");

    if (!storageAvailable) {
      ui.diagnostic.classList.remove("hidden");
      ui.diagnostic.textContent =
        "The quiz loaded, but this browser is blocking saved progress. Use the live GitHub Pages website in Safari or Chrome.";
    }

    addHandlers();
    initCloudSync();
    renderSyncStatus("Offline");
    renderAuth();

    if (state.finished) {
      showResults();
    } else if (state.paused) {
      switchView("paused");
    } else {
      switchView("intro");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
