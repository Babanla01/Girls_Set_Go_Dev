# Manual API Test Guide

This guide lists the HTTP routes currently registered by the backend, the required authentication, request parameters, and practical checks for manually testing them.

## 1. Before testing

Start the backend and its configured PostgreSQL/Redis services. The backend defaults to port `4000`; use the actual `PORT` and `APP_URL` values from your local environment if they differ.

```sh
export BASE_URL="http://localhost:4000"
export API="$BASE_URL/api/v1"
export COOKIE_JAR="/tmp/girls-set-go-cookies.txt"
```

Health routes are version-neutral; all other routes use `/api/v1`.

### Authentication

- `POST /api/v1/auth/login` returns a session cookie. Save it with `curl -c "$COOKIE_JAR"` and send it with `curl -b "$COOKIE_JAR"` on protected routes.
- Admin endpoints require a signed-in account with role `ADMIN`; instructor endpoints require role `INSTRUCTOR`.
- A signed-in user without the required role should receive `403`; a missing/invalid session should receive `401`.
- Send requests without an `Origin` or `Referer` header when using curl. If either header is sent on a write request, its origin must be configured in `APP_URL` or `CORS_ORIGINS`.
- Sensitive public authentication requests are limited to five per minute. The general limit is 100 requests per minute per IP.

Example login (substitute a provisioned account and its password):

```sh
curl -i -c "$COOKIE_JAR" "$API/auth/login" \
  -H 'Content-Type: application/json' \
  --data '{"email":"admin@example.com","password":"ChangeMe123!","portal":"admin"}'
```

Accepted `portal` values: `student`, `instructor`, `admin`. The email is normalized and must be valid; password is a non-empty string of at most 128 characters. Portal must match the account role. Invalid credentials return a generic `401`.

### Shared request rules

- JSON bodies must contain only the documented fields; unknown properties are rejected with `400`.
- UUID path/query values must be valid UUIDs; invalid UUIDs return `400`.
- All paginated list routes accept `page` (integer 1–100000, default `1`) and `pageSize` (integer 1–100, default `20`). Responses have the shape `{ "items": [], "page": 1, "pageSize": 20, "total": 0, "totalPages": 1 }`.
- Unless otherwise noted, successful `POST` creates return `201`; GET/PATCH/DELETE return `200`. The auth routes and state-changing admin POST routes below specify their success status.
- Errors use `{ "statusCode", "error", "message", "path", "requestId", "timestamp" }`.

### Suggested setup sequence

1. Create or obtain an active admin account and log in.
2. Create a track, then create a course under that track and publish it.
3. Create an instructor (the account is invited, not immediately able to log in); retrieve/use its invite token through the configured email/outbox mechanism and accept the invite.
4. Create a cohort for the published course, assign the active instructor, then test the instructor routes using that instructor's login.
5. Exercise updates and archive/restore actions after recording the returned UUIDs. Respect state prerequisites called out below.

Use IDs returned by the API in place of `:id`, `:instructorId`, and other placeholders.

## 2. Health routes (public)

| Method and route | Parameters/body | Expected result / checks |
|---|---|---|
| `GET /api/health` | None | `200`; status, uptime, and timestamp. |
| `GET /api/health/ready` | None | `200` when PostgreSQL and Redis are healthy; otherwise `503` with dependency status. |

Both health routes are public and skip throttling.

## 3. Authentication routes

| Method and route | Auth | Parameters/body | Expected result / checks |
|---|---|---|---|
| `POST /api/v1/auth/login` | Public | JSON: `email`, `password`, `portal` (`student\|instructor\|admin`) | `200` with `{ user }`; sets session cookie. Invalid credentials/portal mismatch: generic `401`. |
| `POST /api/v1/auth/logout` | Session required | No body; send session cookie | `204`; revokes session and clears cookie. |
| `GET /api/v1/auth/me` | Session required | No body; send session cookie | `200` with `{ user }`. |
| `POST /api/v1/auth/forgot-password` | Public | JSON: `email` | `200` with generic `{ message }` whether or not the email exists. |
| `POST /api/v1/auth/reset-password` | Public | JSON: `token` (string, 20–200 chars), `newPassword` (string, max 128 chars) | `200` with `{ message }`; invalid/expired token or password policy failure: `400`. |
| `POST /api/v1/auth/accept-invite` | Public | JSON: `token` (string, 20–200 chars), `newPassword` (string, max 128 chars) | `200` with `{ message }`; invalid/expired invite or password policy failure: `400`. |

`email` must be a valid normalized email. The password service additionally enforces its strength policy (letters, numbers, symbols; common passwords blocked). Reset/invite tokens come from the configured email/outbox mechanism and are single-use/expiring.

Example public password-reset request:

```sh
curl -i "$API/auth/forgot-password" \
  -H 'Content-Type: application/json' \
  --data '{"email":"instructor@example.com"}'
```

## 4. Admin audit logs (ADMIN)

| Method and route | Query parameters | Expected result / checks |
|---|---|---|
| `GET /api/v1/admin/audit-logs` | Pagination plus optional `action` (string, max 100), `actorId` (UUID), `entityType` (string, max 50), `entityId` (string, max 64), `from`, `to` (date or ISO datetime) | `200`, paginated audit records newest first. Try `?page=1&pageSize=20&action=auth.login_failed` or filter by `actorId`/entity/date. |

## 5. Admin tracks (ADMIN)

Track name is cleaned/trimmed and must be 2–100 characters. Optional `description` is a string up to 2000 characters. New tracks always start `ACTIVE`.

| Method and route | Parameters/body | Expected result / checks |
|---|---|---|
| `POST /api/v1/admin/tracks` | JSON: required `name`; optional `description` | `201`, `{ track }`. Extra fields such as `status` are rejected. |
| `GET /api/v1/admin/tracks` | Query: pagination; optional `search` (max 100), `status` (`ACTIVE\|ARCHIVED`), `sortBy` (`name\|createdAt`), `sortDir` (`asc\|desc`) | `200`, paginated tracks. |
| `GET /api/v1/admin/tracks/:id` | Path `id` UUID | `200`, `{ track }`; unknown ID: `404`. |
| `PATCH /api/v1/admin/tracks/:id` | Path `id` UUID; JSON may include `name` and/or `description` | `200`, `{ track }`; empty body: `400`; unknown ID: `404`. Empty description clears it. |
| `POST /api/v1/admin/tracks/:id/archive` | Path `id` UUID; no body | `200`, `{ track }`; conflict if already archived or if active courses remain. |
| `POST /api/v1/admin/tracks/:id/restore` | Path `id` UUID; no body | `200`, `{ track }`; conflict if it is not archived. |

Example create:

```sh
curl -i -b "$COOKIE_JAR" "$API/admin/tracks" \
  -H 'Content-Type: application/json' \
  --data '{"name":"Digital Skills","description":"Foundational technology programme"}'
```

## 6. Admin courses (ADMIN)

A course requires an existing `trackId` UUID. `title` is cleaned/trimmed and must be 2–150 characters; optional `description` is up to 5000 characters. New courses always start `DRAFT`.

| Method and route | Parameters/body | Expected result / checks |
|---|---|---|
| `POST /api/v1/admin/courses` | JSON: required `trackId`, `title`; optional `description` | `201`, `{ course }`; extra fields such as `status` are rejected. |
| `GET /api/v1/admin/courses` | Query: pagination; optional `search` (max 150), `trackId` (UUID), `status` (`DRAFT\|PUBLISHED\|ARCHIVED`), `sortBy` (`title\|createdAt`), `sortDir` (`asc\|desc`) | `200`, paginated courses. |
| `GET /api/v1/admin/courses/:id` | Path `id` UUID | `200`, `{ course }`; unknown ID: `404`. |
| `PATCH /api/v1/admin/courses/:id` | Path `id` UUID; JSON may include `title` and/or `description` | `200`, `{ course }`; empty body: `400`; unknown ID: `404`. Track cannot be changed. Empty description clears it. |
| `POST /api/v1/admin/courses/:id/publish` | Path `id` UUID; no body | `200`, `{ course }`; only a draft can be published. |
| `POST /api/v1/admin/courses/:id/unpublish` | Path `id` UUID; no body | `200`, `{ course }`; only a published course can be unpublished; active cohorts cause conflict. |
| `POST /api/v1/admin/courses/:id/archive` | Path `id` UUID; no body | `200`, `{ course }`; conflict if already archived or active cohorts exist. |
| `POST /api/v1/admin/courses/:id/restore` | Path `id` UUID; no body | `200`, `{ course }`; requires archived course and an active parent track; restores as `DRAFT`. |

Example create:

```sh
curl -i -b "$COOKIE_JAR" "$API/admin/courses" \
  -H 'Content-Type: application/json' \
  --data '{"trackId":"<track-uuid>","title":"Introduction to Coding","description":"A beginner course"}'
```

## 7. Admin instructors (ADMIN)

| Method and route | Parameters/body | Expected result / checks |
|---|---|---|
| `POST /api/v1/admin/instructors` | JSON: required `fullName` (trimmed, 2–120 chars), `email` (valid normalized email) | `201`, `{ instructor }`; creates an `INVITED` instructor and queues an invitation. No password or role field is accepted. |
| `GET /api/v1/admin/instructors` | Query: pagination; optional `search` (max 100), `status` (`INVITED\|ACTIVE\|SUSPENDED`), `sortBy` (`createdAt\|fullName\|email\|lastLoginAt`), `sortDir` (`asc\|desc`) | `200`, paginated instructors. |
| `GET /api/v1/admin/instructors/:id` | Path `id` UUID | `200`, instructor and invite state; unknown ID: `404`. |
| `PATCH /api/v1/admin/instructors/:id` | Path `id` UUID; JSON may include `fullName` (2–120 chars) and/or `email` (valid normalized email) | `200`, `{ instructor }`; email can be changed only while invitation is pending. |
| `POST /api/v1/admin/instructors/:id/resend-invite` | Path `id` UUID; no body | `200`, `{ instructor }`; only pending invitations can be resent. |
| `POST /api/v1/admin/instructors/:id/suspend` | Path `id` UUID; optional JSON `{ "reason": "..." }` (trimmed, max 500 chars) | `200`, `{ instructor }`; revokes that instructor's sessions. Empty body is allowed. |
| `POST /api/v1/admin/instructors/:id/reactivate` | Path `id` UUID; no body | `200`, `{ instructor }`; only suspended instructors can be reactivated; pending invite may be reissued. |

Example create:

```sh
curl -i -b "$COOKIE_JAR" "$API/admin/instructors" \
  -H 'Content-Type: application/json' \
  --data '{"fullName":"Ada Lovelace","email":"ada@example.com"}'
```

## 8. Admin cohorts (ADMIN)

Create requires an existing `courseId` UUID, `name` (cleaned, 2–120 chars), `startsOn` and `endsOn` as real `YYYY-MM-DD` calendar dates. Optional `capacity` is an integer from 1–10000. End date must not be before start date. Cohort/course state and instructor assignment rules are enforced by the service.

| Method and route | Parameters/body | Expected result / checks |
|---|---|---|
| `POST /api/v1/admin/cohorts` | JSON: required `courseId`, `name`, `startsOn`, `endsOn`; optional `capacity` | `201`, `{ cohort }`; invalid dates/order: `400`; unavailable/archived course is rejected. |
| `GET /api/v1/admin/cohorts` | Query: pagination; optional `search` (max 120), `courseId` (UUID), `trackId` (UUID), `status` (`ACTIVE\|ARCHIVED`), `phase` (`upcoming\|running\|ended`), `sortBy` (`startsOn\|name\|createdAt`), `sortDir` (`asc\|desc`) | `200`, paginated cohorts. |
| `GET /api/v1/admin/cohorts/:id` | Path `id` UUID | `200`, cohort with assigned instructors; unknown ID: `404`. |
| `PATCH /api/v1/admin/cohorts/:id` | Path `id` UUID; JSON may include `name`, `startsOn`, `endsOn`, and/or `capacity` | `200`, `{ cohort }`; empty body/date order invalid: `400`; `capacity: null` removes limit; archived cohort cannot be edited. |
| `POST /api/v1/admin/cohorts/:id/archive` | Path `id` UUID; no body | `200`, `{ cohort }`; conflict if already archived. |
| `POST /api/v1/admin/cohorts/:id/restore` | Path `id` UUID; no body | `200`, `{ cohort }`; requires archived cohort and a non-archived course. |
| `POST /api/v1/admin/cohorts/:id/instructors` | Path `id` UUID; JSON: required `instructorId` UUID | `200`, `{ instructors }`; rejects archived cohort, missing/suspended instructor, or duplicate assignment. |
| `DELETE /api/v1/admin/cohorts/:id/instructors/:instructorId` | Path `id` UUID and `instructorId` UUID; no body | `200`, `{ instructors }`; `404` if cohort or assignment is missing. |

Example create and assignment:

```sh
curl -i -b "$COOKIE_JAR" "$API/admin/cohorts" \
  -H 'Content-Type: application/json' \
  --data '{"courseId":"<course-uuid>","name":"November 2026 Cohort","startsOn":"2026-11-02","endsOn":"2027-01-29","capacity":30}'

curl -i -b "$COOKIE_JAR" "$API/admin/cohorts/<cohort-uuid>/instructors" \
  -H 'Content-Type: application/json' \
  --data '{"instructorId":"<instructor-uuid>"}'
```

## 9. Instructor cohorts (INSTRUCTOR)

| Method and route | Parameters/body | Expected result / checks |
|---|---|---|
| `GET /api/v1/instructor/cohorts` | Query: pagination; optional `status` (`ACTIVE\|ARCHIVED`, default `ACTIVE`) | `200`, paginated cohorts assigned to the signed-in instructor. Confirm default status and both status filters. |
| `GET /api/v1/instructor/cohorts/:id` | Path `id` UUID | `200`, cohort and co-instructor names; `404` if it does not exist or is not assigned to the signed-in instructor. |

Log in using `portal: "instructor"` and the accepted invitation's credentials before testing. An admin or other instructor should receive `403` for these routes.

## 10. Cross-cutting negative checks

Run these checks on representative routes (and especially before considering a manual test pass):

- Call a protected route without a cookie: expect `401`.
- Call an admin route as an instructor, and an instructor route as an admin: expect `403`.
- Send an invalid UUID or invalid enum/filter: expect `400`.
- Send an undocumented property in a JSON body or query string: expect `400` (the global validation pipe forbids unknown fields).
- Try an invalid date such as `2026-02-30`, a cohort end date before its start date, and capacity `0`/`10001`: expect `400`.
- Try missing resources, invalid state transitions, duplicate assignment, and resource dependency conflicts: expect the documented `404` or `409`/conflict response.
- Verify session logout makes subsequent protected requests fail, and suspending an instructor revokes their existing session.
- Check list defaults and boundary pagination: `page=1&pageSize=1`, then `page=0` and `pageSize=101` (the latter invalid).
