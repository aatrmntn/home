# NW7 Urlaubsplaner

Leave planner for a private household, built from the feminin practice planner
(github.com/aatrmntn/feminin, folder urlaubsplaner). Same architecture, own AWS stack.
This folder is its own app; the rest of the repository is the family meal planner.

- AWS eu-central-1 only. Infrastructure as code (CDK) in /infra; deploy with `npm run deploy`.
  Stack `NW7Urlaubsplaner`, login address prefix `nw7-urlaub` (override: `-c domainPrefix=`).
- Frontend: plain HTML/CSS/JS in /web. No framework, no runtime CDN scripts.
- API: one Node.js Lambda in /api. All counting and validation in /api/rules.js.
- Every endpoint checks the Cognito user and group itself. User id from the token only.
- Login: username + password only, no authenticator app (min. 12 characters).
- Every write uses a DynamoDB condition (rev) and writes an audit record.
- Never log notes, tokens or passwords. No secrets in the repository.
- **Real names never go into this repository (it is public).** Code and tests use made-up
  names; messages say "die Eltern", "die Organisation". The start data with real names is
  pasted into Einstellungen → Startdaten übernehmen and never committed. The same goes for
  the names of the children's school and kindergarten.
- Run `npm test` before every commit; add a test for every rule you change.
- `npm run dev` starts a local copy with an in-memory database and fake logins.

## Who is who

- Roles (`person.role`): `family` (the parents; their holiday is the family holiday),
  `household` (staff with a leave account, usually without login), `office` (the
  assistant; organises, has no leave account, is not shown in the overview).
- Cognito groups: `approver` (the parents: approve, hand out logins and rights, set the
  children's calendar and household settings), `planner` (the assistant: enters for
  everyone, keeps people, holidays and start data, sees requests, cannot approve),
  `staff` (anyone else with a login). `person.approver` / `person.planner` mirror them.
- People without login: `login: false`, userId `ohne-zugang-<uuid>`, no Cognito user.
  Created by approvers or the planner. Only approvers create logins or change rights.
- The family's own entries are approved at once (no request). Staff entries entered by the
  planner are pending until a parent approves; parents can tick "Ist schon genehmigt".
- Vertretung (substitute) is for household staff entries.

## Rules specific to NW7

- **Sperrzeiten** (`person.sperrzeiten`): no leave while the children are free (school
  or kindergarten, summer included) and in the week before and the week after the family
  holiday (`FAMILY_BUFFER_DAYS = 7`; days of the family holiday itself are fine).
  rules.blockedDays / describeBlocked. Booking still works; the warning shows in the
  drawer and in the requests inbox. Manual holidays can be marked `soft` ("nach Absprache").
- **Children's free days** = manual list `settings.ferien` + the children's calendar.
  The calendar is a published .ics link (iCloud "Öffentlicher Kalender", webcal:// becomes
  https://) set by approvers (`settings.kinderFeed = { url, words }`). api/kinder-feed.js
  keeps events whose title contains a "free" word; titles with a kindergarten word go to the
  kindergarten row, the rest to school. The result is cached in `settings.kinderCache` and
  read again after 3 hours on any request that needs it, or at once with "jetzt abgleichen"
  (POST /api/kinder-kalender/abgleich). When reading fails, the last days stay and the error
  shows in Einstellungen. The words for the actual school and kindergarten are entered in the
  app, not in the code.
- **Resturlaub laut Stand** (`person.rest = { days, asOf }`): stored as `person.snapshot`
  (rules.restSnapshot), so the account starts on that date with that rest in the current
  leave year; the next allowance comes at the next anniversary of the start date.
- settings.putSettings replaces the whole record, so every write merges with the stored
  settings (holidays, calendar link and cache live there too).
- No minimum staffing by default (`minimumStaffing: {}`); the engine is still there.
- Door notices and the feminin logo were removed. Colours: sage green (style.css).

## Inherited from the feminin planner (still true)

- Leave year = working year from the start date (Eintritt); 25 days on a 5-day week,
  scaled for part-time; leftovers expire two years after the end of their leave year.
- Closures ("Alle frei") are entries with kind `closure`, approvers only.
- Calendar feed `/feed/<token>.ics` without login; never notes.
- Retention: on 2 January entries older than the current year plus two are deleted after
  storing each person's account as a snapshot.
