# AWS SAA-C03 Quiz Project Context

## Project Overview

AWS SAA-C03 practice quiz website hosted on GitHub Pages.

Purpose:

* Study for AWS Solutions Architect Associate (SAA-C03)
* Cross-device progress synchronization
* Session-based exam simulation
* Wrong-answer review and retention
* Mobile and desktop support

Production URL:

https://amanrai16300-test.github.io/aws-saa-quiz/

Repository:

https://github.com/amanrai16300-test/aws-saa-quiz

---

# Current Architecture

## Frontend

Static GitHub Pages website.

Files:

* index.html
* app.js
* questions.js
* style.css
* supabase-config.js
* supabase-sync.js
* supabase-schema.sql

No backend server.

No Node.js.

No Express.

No PHP.

No AWS backend.

---

## Database

Supabase

Purpose:

* Authentication
* Cloud progress storage
* Durable completed-session history
* Cross-device synchronization

Database tables:

* `public.quiz_progress` — active quiz state and cross-device progress
* `public.quiz_history` — durable completed main-session history

Row Level Security enabled on both tables.

Users can access only their own records.

### quiz_history

* Each completed main session is stored as its own row, keyed by its unique history ID.
* RLS allows select, insert, and update for the owning user.
* No normal delete policy exists for `quiz_history` (history rows are not deleted through the app).
* Wrong-answer practice sessions are never stored in `quiz_history`.
* Existing local history is migrated once and upserted by history ID.
* `quiz_history` is the durable source of truth for completed main-session records.

---

# Question Bank

Current question count:

684

Question IDs:

1–684

Stored in:

questions.js

Important:

Question IDs must remain stable.

Do not renumber questions.

Do not change IDs of existing questions.

Progress synchronization depends on question IDs remaining unchanged.

---

# Session Rules

## Main Session

Question pool:

1–684

Questions per session:

64

Behavior:

* Questions do not repeat until the current 684-question cycle is exhausted.
* If a session reaches the end of a cycle, the next cycle begins automatically.
* A question must never appear twice in the same session.
* Question order randomized every session.
* Option order randomized every session.

---

# Progress Storage

## Local

Browser localStorage.

Purpose:

* Offline support
* Fast loading
* Cache

## Cloud

Supabase

Purpose:

* Mobile/Desktop synchronization
* Account-based progress
* Durable completed-session history

Conflict handling:

Active quiz state (`quiz_progress`) is timestamp-based: newest timestamp wins, and older device state must never overwrite newer progress.

Completed main-session history is NOT resolved by timestamp alone. History uses merge-by-ID against durable `quiz_history` rows:

* Main-session history is merged by unique history ID.
* A device with fewer history entries must not overwrite valid entries from another device.
* History is merged rather than replaced.
* `quiz_history` is the durable source for completed main-session records.

---

# Authentication

Provider:

Supabase Auth

Supported:

* Email signup
* Email login
* Logout
* Password reset

GitHub Pages URL configured in Supabase:

https://amanrai16300-test.github.io/aws-saa-quiz/

---

# Synchronization

Current status:

Implemented

Features:

* Automatic cloud save
* Automatic cloud load
* Realtime updates between devices
* Debounced saves (~500ms)
* Immediate flush on:

  * pause
  * session finish
  * logout
  * page hidden

* Main history rows are saved immediately to `quiz_history`.
* Before cloud progress is saved, the latest cloud payload is read and cloud/local history is merged.
* LocalStorage remains the offline cache and signed-out storage.
* Active-state conflict handling remains timestamp-based; history is merged rather than replaced.

Realtime subscription:

quiz_progress

Behavior:

Changes on one device should appear on another device within seconds.

---

# Session History

## Important Design Decision

Only MAIN sessions appear in Session History.

Wrong-answer practice sessions must never create history entries.

History entry contains:

* Session score
* Session metadata
* Wrong question IDs
* Per-question cycle data (`questionCycles`) for new entries

Wrong-answer practice is launched from the main session history entry.

## History Reliability

* Main-session history is merged by unique history ID.
* Missing/null legacy `mode` values are treated as main history.
* Only entries where `mode === "wrong"` are excluded.
* Before cloud progress is saved, the latest cloud payload is read and cloud/local history is merged.
* A device with fewer history entries must not overwrite valid entries from another device.
* `quiz_history` is the durable source for completed main-session records.

## Question-Cycle Recovery

* New main history entries store per-question cycle data through `questionCycles`.
* After durable history loads, the current tracker removes completed current-cycle questions from its unused pool.
* Old single-cycle history can be repaired safely.
* Ambiguous legacy multi-cycle history without per-question cycle data is skipped (not guessed).
* History recovery must never change `tracker.cycleNumber`.
* Active unfinished session items must never be modified by tracker recovery.

---

# Wrong Answer Practice

Supported:

* Current session wrong-answer practice
* Historical session wrong-answer practice

Behavior:

* Practice can be repeated indefinitely.
* No new history entries created.
* Main session history remains permanent.

---

# Main / Wrong Session Storage

Main sessions and wrong-answer practice are persisted separately using:

* `mainSlot`
* `wrongSlot`

Behavior:

* Switching sessions saves the current slot before restoring the other.
* Both main and wrong-practice sessions preserve:

  * current question
  * selected/submitted answers
  * timer
  * question order
  * shuffled option order

* Starting a new main session does not delete the saved wrong-practice session.
* Wrong-practice sessions do not create Session History entries.

Resume logic:

* "Resume Main Session" only restores a valid unfinished 64-question state where `mode === "main"`.
* If no valid unfinished main session exists, the button becomes "Start New Main Session".
* Wrong-practice state, `wrongSlot`, and legacy `returnState` must never be treated as a main session.

---

# Theme

* Light and dark themes are implemented.
* Theme preference is stored in localStorage.
* System preference is used only when no saved choice exists.
* Theme initialization is independent from quiz boot logic.
* The icon-only theme toggle is positioned at the top-right.
* Safari iOS Add to Home Screen (standalone) mode is supported.
* Dark mode uses balanced surfaces, text, borders, form controls, feedback states, and history cards.

---

# Files And Responsibilities

## index.html

UI structure.

Authentication controls.

Quiz layout.

Theme icon (top-right).

Main/wrong session action buttons.

## style.css

Visual styling.

Responsive behavior.

Light/dark theming.

## app.js

Core quiz logic.

Responsibilities:

* Question selection
* Session generation
* History management and merge
* Separate main/wrong session slots
* Wrong-answer practice
* Durable-history loading and tracker repair
* Progress persistence
* Theme-independent quiz behavior

## questions.js

Question database.

Must not be modified unless updating questions.

## supabase-config.js

Contains:

* Project URL
* Publishable key

Never store secret keys.

## supabase-sync.js

Responsibilities:

* Authentication
* Progress transport (cloud saves / loads)
* Realtime synchronization
* Cloud-history row loading and upsert
* Pre-save history merge

## supabase-schema.sql

Responsibilities:

* `quiz_progress` table
* `quiz_history` table
* Indexes
* RLS policies for both tables

---

# Things That Must Not Change

Do not:

* Renumber question IDs
* Drop quiz_progress table
* Drop quiz_history table
* Add a normal delete policy to quiz_history
* Remove RLS
* Store full question bank in Supabase
* Put service-role keys in frontend
* Create history entries for wrong-practice sessions
* Store wrong-practice sessions in quiz_history
* Change tracker.cycleNumber during history recovery
* Break GitHub Pages compatibility

---

# Deployment Workflow

Branch workflow:

feature/*

Merge into:

main

Deploy target:

GitHub Pages

Deployment process:

git checkout main

git merge feature/branch-name

git push

GitHub Pages deploys automatically.

## Deployment Warning

* The updated `supabase-schema.sql` must be run in Supabase BEFORE deploying code that depends on `quiz_history`.
* GitHub Pages deploys from `main`.
* Current feature branch for tracker recovery: `fix/tracker-recovery`.

---

# Implemented Features

* Cross-device cloud sync (Supabase Realtime on `quiz_progress`)
* Append-only / upsert-by-ID completed main-session history (`quiz_history`)
* Merge-by-ID history reliability across devices
* Question-cycle tracker recovery from durable history
* Separate main / wrong-practice session resume (`mainSlot` / `wrongSlot`)
* Light and dark themes (icon toggle, Safari standalone support)

---

# Future Improvements

Potential future features:

* Exam mode
* Study mode
* Category filtering
* Bookmark questions
* Statistics dashboard
* Question search
* AWS service breakdown
* Weak-area analysis
* Multi-exam support

Must preserve:

* Existing question IDs
* Existing user progress
* Existing history records
* Existing Supabase schema (`quiz_progress` and `quiz_history`)
