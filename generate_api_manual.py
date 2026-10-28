from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.enum.section import WD_SECTION

OUTPUT = "API_MANUAL_TEST_GUIDE.docx"

routes = []
def add(section, method, path, auth, inputs, body, success, test, example=None):
    routes.append(dict(section=section, method=method, path=path, auth=auth, inputs=inputs, body=body, success=success, test=test, example=example))

# Health
s="Health checks (public)"
add(s,"GET","/api/health","No login needed","No path, query, or body parameters.","No request body.","200 OK. The response reports service status, uptime, and current timestamp.","Call it with the backend running. It should respond even if you are not logged in.")
add(s,"GET","/api/health/ready","No login needed","No path, query, or body parameters.","No request body.","200 OK when PostgreSQL and Redis are both ready; 503 Service Unavailable if either dependency is unavailable.","Call once with the database and Redis running. If you can safely stop a dependency in a local test environment, call again and confirm readiness fails.")
# Authentication
s="Sign-in and password links"
add(s,"POST","/api/v1/auth/login","Public","JSON fields: email (valid email), password (1–128 characters), portal (exactly student, instructor, or admin). The selected portal must match the account role.",'{"email":"admin@example.com","password":"ChangeMe123!","portal":"admin"}',"200 OK, returns the signed-in user and sets a session cookie. Wrong credentials or wrong portal: 401 Unauthorized.","Use credentials for an existing active account. Save the cookie from the response; use it on later protected calls.")
add(s,"POST","/api/v1/auth/logout","Must have a valid session cookie","No path, query, or body parameters. Send the saved session cookie.","No request body.","204 No Content. The session is revoked and the cookie is cleared.","Log in first, call logout, then call /api/v1/auth/me with the old cookie. The final call should return 401.")
add(s,"GET","/api/v1/auth/me","Must have a valid session cookie","No path, query, or body parameters.","No request body.","200 OK with the current user. Without a valid session: 401 Unauthorized.","Call after login with the saved cookie; check the returned user matches the account.")
add(s,"POST","/api/v1/auth/forgot-password","Public","JSON field: email (valid email).","{\"email\":\"instructor@example.com\"}","200 OK with a generic message whether or not the account exists.","Request a link for a test account. The generic response must not reveal whether the email is registered. Find the link through the configured local email/outbox setup.")
add(s,"POST","/api/v1/auth/reset-password","Public","JSON fields: token (20–200 characters from a reset link), newPassword (up to 128 characters and meets the password rules).","{\"token\":\"<reset-token-from-email>\",\"newPassword\":\"NewStrongPass123!\"}","200 OK with a message. Invalid/expired token or password that fails policy: 400 Bad Request.","Request a reset link first. Use the token once, then try it again; the second use should fail.")
add(s,"POST","/api/v1/auth/accept-invite","Public","JSON fields: token (20–200 characters from the invitation), newPassword (up to 128 characters and meets the password rules).","{\"token\":\"<invite-token-from-email>\",\"newPassword\":\"NewStrongPass123!\"}","200 OK with a message. Invalid/expired token or password that fails policy: 400 Bad Request.","Create an invited instructor as admin, retrieve the invitation through configured email/outbox, and accept it. The invited user should then be able to sign in.")
# public catalog
s="Public catalog"
add(s,"GET","/api/v1/public/tracks","No login needed","No path, query, or body parameters.","No request body.","200 OK with { tracks }. Only active tracks are returned, ordered by name.","Call with no cookie. Confirm archived tracks do not appear.")
# student
s="Student registration and self-service"
student_body='''{\n  "fullName":"Jordan Example",\n  "email":"jordan@example.com",\n  "phone":"+15551234567",\n  "dateOfBirth":"2008-04-12",\n  "location":"Springfield",\n  "schoolName":"Central High School",\n  "gradeLevel":"11",\n  "preferredTrackId":"<active-track-uuid>",\n  "whyJoin":"I want to learn practical technology skills.",\n  "hopeToLearn":"I hope to build useful projects and learn coding.",\n  "stemExperience":"I have tried a beginner coding activity.",\n  "password":"StrongPass123!",\n  "confirmPassword":"StrongPass123!",\n  "acceptTerms":true,\n  "acceptPrivacy":true\n}'''
add(s,"POST","/api/v1/students/register","Public","JSON required: fullName (2–120 characters); email (valid email); phone (valid phone); dateOfBirth (real YYYY-MM-DD date); location and schoolName (2–200 characters each); gradeLevel (1–50 characters); preferredTrackId (UUID of an active track); whyJoin and hopeToLearn (10–2,000 characters each); password and confirmPassword (up to 128 characters, must match and meet password policy); acceptTerms and acceptPrivacy (both must be true). Optional: stemExperience (up to 2,000 characters); guardianName (2–120), guardianEmail (valid email), guardianPhone (valid phone), guardianConsent (boolean); website (hidden bot-trap, up to 200 characters). Applicants under 18 must provide all guardian details and guardianConsent=true. Adults can provide all or none of the guardian details.",student_body,"201 Created, sets a session cookie, returns the user, application, and emailVerified flag. If the optional website bot-trap is filled, response is { received: true } and no account is created.","Use an active track UUID from GET /api/v1/public/tracks. Use a unique email. For an under-18 test birth date, include guardianName, guardianEmail, guardianPhone, and guardianConsent=true. Then verify the account was created and a verification email was queued.")
add(s,"POST","/api/v1/students/verify-email","Public","JSON field: token (20–200 characters from verification email).","{\"token\":\"<verification-token-from-email>\"}","200 OK with a confirmation message. Invalid, expired, or already-used token: 400 Bad Request.","Register a test student, obtain the verification token from the configured email/outbox, and submit it once. Reusing it should fail.")
add(s,"POST","/api/v1/students/me/resend-verification","Must be logged in as the STUDENT whose email is not verified","No path, query, or body parameters. Send student session cookie.","No request body.","200 OK with a message and a new verification email queued. Already-verified email: conflict response.","Log in as an unverified student and call it. Check local email/outbox for the new message. Admin or instructor account should receive 403.")
add(s,"GET","/api/v1/students/me/dashboard","Must be logged in as a STUDENT","No path, query, or body parameters. Send student session cookie.","No request body.","200 OK with the student's application/enrollment/course-access status and a message.","Call as a student before and after an admin decision. Confirm dashboard state changes from pending to accepted or declined as appropriate.")
# Admin audit
s="Admin audit log"
add(s,"GET","/api/v1/admin/audit-logs","Must be logged in as ADMIN","Query: page (1–100000; default 1), pageSize (1–100; default 20), optional action (max 100 characters), actorId (UUID), entityType (max 50), entityId (max 64), from and to (valid date/time).","No request body.","200 OK with paginated results, newest first.","Call with page=1&pageSize=20, then add action=auth.login_failed. Try an invalid actorId to confirm validation returns 400.")
# tracks
s="Admin tracks"
add(s,"POST","/api/v1/admin/tracks","Must be logged in as ADMIN","JSON: name is required (2–100 characters); description is optional (up to 2,000 characters). New tracks are ACTIVE automatically.",'{"name":"Digital Skills","description":"Foundational technology programme"}',"201 Created with the new track.","Create a track and record the returned track ID. Send an extra field such as status as a negative check; unknown fields should return 400.")
add(s,"GET","/api/v1/admin/tracks","Must be logged in as ADMIN","Query: page, pageSize; optional search (max 100), status (ACTIVE or ARCHIVED), sortBy (name or createdAt), sortDir (asc or desc).","No request body.","200 OK with a page of tracks.","Call with ?search=digital&status=ACTIVE&page=1&pageSize=20. Try status=UNKNOWN; expect 400.")
add(s,"GET","/api/v1/admin/tracks/:id","Must be logged in as ADMIN","Path id: UUID of a track.","No request body.","200 OK with the track. Unknown UUID: 404; malformed UUID: 400.","Replace :id with the ID returned when creating a track.")
add(s,"PATCH","/api/v1/admin/tracks/:id","Must be logged in as ADMIN","Path id: UUID. JSON may include name (2–100 characters) and/or description (up to 2,000 characters). Include at least one field. Empty description clears it.",'{"name":"Digital Skills Updated"}',"200 OK with the updated track. Empty JSON or no fields: 400.","Update the track created earlier, then GET it to verify. Try an empty object as a negative test.")
add(s,"POST","/api/v1/admin/tracks/:id/archive","Must be logged in as ADMIN","Path id: UUID of an active track. No body.","No request body.","200 OK. Conflict if already archived or active courses still exist.","Use a track with no active courses. Archive it, then check it appears with status=ARCHIVED. Try archiving it again to test conflict.")
add(s,"POST","/api/v1/admin/tracks/:id/restore","Must be logged in as ADMIN","Path id: UUID of an archived track. No body.","No request body.","200 OK. Conflict if the track is not archived.","Restore the track you just archived. Confirm status becomes ACTIVE.")
# courses
s="Admin courses"
add(s,"POST","/api/v1/admin/courses","Must be logged in as ADMIN","JSON: trackId (existing track UUID), title (2–150 characters), optional description (up to 5,000 characters). New courses start as DRAFT.",'{"trackId":"<track-uuid>","title":"Introduction to Coding","description":"A beginner course"}',"201 Created with the course.","Use an active track ID. Record the returned course ID. Extra field status should be rejected.")
add(s,"GET","/api/v1/admin/courses","Must be logged in as ADMIN","Query: page, pageSize; optional search (max 150), trackId (UUID), status (DRAFT, PUBLISHED, ARCHIVED), sortBy (title or createdAt), sortDir (asc or desc).","No request body.","200 OK with a page of courses.","Filter by the trackId and status=DRAFT to find the course you created. Invalid status should return 400.")
add(s,"GET","/api/v1/admin/courses/:id","Must be logged in as ADMIN","Path id: UUID of a course.","No request body.","200 OK with the course. Unknown UUID: 404; malformed UUID: 400.","Use the course ID from create.")
add(s,"PATCH","/api/v1/admin/courses/:id","Must be logged in as ADMIN","Path id: UUID. JSON may include title (2–150 characters) and/or description (up to 5,000 characters). Track cannot be changed. Include at least one field.",'{"title":"Coding Basics"}',"200 OK with the updated course. Empty update: 400.","Change title, then GET the course and verify. Try sending trackId to confirm unsupported fields are rejected.")
add(s,"POST","/api/v1/admin/courses/:id/publish","Must be logged in as ADMIN","Path id: UUID of a DRAFT course. No body.","No request body.","200 OK; course becomes PUBLISHED. Only a draft can be published.","Publish the draft course and verify its status. Repeat to test invalid transition.")
add(s,"POST","/api/v1/admin/courses/:id/unpublish","Must be logged in as ADMIN","Path id: UUID of a PUBLISHED course. No body.","No request body.","200 OK; course returns to DRAFT. Active cohorts can cause a conflict.","Use a published course with no active cohorts. Try with active cohorts separately to confirm conflict.")
add(s,"POST","/api/v1/admin/courses/:id/archive","Must be logged in as ADMIN","Path id: UUID of a course. No body.","No request body.","200 OK; course becomes ARCHIVED. Active cohorts or an already archived state can cause conflict.","Use a course without active cohorts. Confirm it is removed from normal active lists or appears when filtered ARCHIVED.")
add(s,"POST","/api/v1/admin/courses/:id/restore","Must be logged in as ADMIN","Path id: UUID of an ARCHIVED course whose parent track is ACTIVE. No body.","No request body.","200 OK; course is restored as DRAFT.","Archive a course, then restore it. A course under an archived track should not be restorable.")
# instructors
s="Admin instructors"
add(s,"POST","/api/v1/admin/instructors","Must be logged in as ADMIN","JSON: fullName (2–120 characters) and email (valid email). The account is invited; do not send password or role.",'{"fullName":"Ada Lovelace","email":"ada@example.com"}',"201 Created with an invited instructor; an invitation email is queued.","Use a unique email and record instructor ID. Retrieve invitation via local email/outbox to test accept-invite. Unknown body fields should return 400.")
add(s,"GET","/api/v1/admin/instructors","Must be logged in as ADMIN","Query: page, pageSize; optional search (max 100), status (INVITED, ACTIVE, SUSPENDED), sortBy (createdAt, fullName, email, lastLoginAt), sortDir (asc or desc).","No request body.","200 OK with paginated instructors.","Search by the name/email created above. Try status=UNKNOWN; expect 400.")
add(s,"GET","/api/v1/admin/instructors/:id","Must be logged in as ADMIN","Path id: UUID of an instructor.","No request body.","200 OK with instructor details and invitation state. Missing record: 404.","Use the ID returned by create.")
add(s,"PATCH","/api/v1/admin/instructors/:id","Must be logged in as ADMIN","Path id: UUID. JSON may include fullName (2–120 characters) and/or email (valid email). Email changes are allowed only while invite is pending.",'{"fullName":"Ada Byron"}',"200 OK with the updated instructor. Invalid values or forbidden email change are rejected.","Change the invited instructor's name. If you change email, use a pending invite and verify the updated email. Try after acceptance to confirm restriction.")
add(s,"POST","/api/v1/admin/instructors/:id/resend-invite","Must be logged in as ADMIN","Path id: UUID of an instructor with a pending invitation. No body.","No request body.","200 OK with instructor; new invitation is queued. Non-pending invitation is rejected.","Use an invited, not-yet-accepted instructor. Check the email/outbox for a fresh link; prior link should no longer be relied upon.")
add(s,"POST","/api/v1/admin/instructors/:id/suspend","Must be logged in as ADMIN","Path id: UUID. Optional JSON reason: string up to 500 characters. Empty body is allowed.",'{"reason":"Temporary leave"}',"200 OK with instructor status SUSPENDED; existing sessions are revoked.","Suspend an active instructor. Try their old cookie on a protected route and confirm it no longer works.")
add(s,"POST","/api/v1/admin/instructors/:id/reactivate","Must be logged in as ADMIN","Path id: UUID of a suspended instructor. No body.","No request body.","200 OK. Only a suspended instructor can be reactivated; pending invites may be reissued.","Reactivate the instructor you suspended and confirm the status changes. Try an already-active instructor to check invalid state handling.")
# cohorts
s="Admin cohorts and instructor assignments"
add(s,"POST","/api/v1/admin/cohorts","Must be logged in as ADMIN","JSON: courseId (existing course UUID), name (2–120 characters), startsOn and endsOn (real YYYY-MM-DD dates), optional capacity (integer 1–10,000). End cannot be before start.",'{"courseId":"<course-uuid>","name":"November 2026 Cohort","startsOn":"2026-11-02","endsOn":"2027-01-29","capacity":30}',"201 Created with the cohort. Invalid dates/order return 400; unusable or archived course is rejected.","Use a published course. Record cohort ID. Try 2026-02-30, an end before start, and capacity 0 as negative checks.")
add(s,"GET","/api/v1/admin/cohorts","Must be logged in as ADMIN","Query: page, pageSize; optional search (max 120), courseId and trackId (UUIDs), status (ACTIVE or ARCHIVED), phase (upcoming, running, ended), sortBy (startsOn, name, createdAt), sortDir (asc or desc).","No request body.","200 OK with paginated cohorts.","Try ?courseId=<course-uuid>&status=ACTIVE&phase=upcoming&page=1&pageSize=20. Invalid phase returns 400.")
add(s,"GET","/api/v1/admin/cohorts/:id","Must be logged in as ADMIN","Path id: UUID of a cohort.","No request body.","200 OK with cohort and assigned instructors. Missing record: 404.","Use the ID returned by create.")
add(s,"PATCH","/api/v1/admin/cohorts/:id","Must be logged in as ADMIN","Path id: UUID. JSON may include name (2–120 characters), startsOn/endsOn (real YYYY-MM-DD), capacity (integer 1–10,000), or capacity=null to remove limit. At least one field required.",'{"capacity":null}',"200 OK with updated cohort. Invalid date order, empty update, or archived cohort: 400/rejected.","Set capacity to 40, then set it to null and confirm the limit is removed. Try editing an archived cohort.")
add(s,"POST","/api/v1/admin/cohorts/:id/archive","Must be logged in as ADMIN","Path id: UUID of an active cohort. No body.","No request body.","200 OK. Already archived cohort can conflict.","Archive a cohort with no blocking dependencies, then confirm status. Test duplicate archive separately.")
add(s,"POST","/api/v1/admin/cohorts/:id/restore","Must be logged in as ADMIN","Path id: UUID of an archived cohort whose course is not archived. No body.","No request body.","200 OK. Requires an archived cohort and a non-archived course.","Restore the cohort you archived, then verify status in GET detail.")
add(s,"POST","/api/v1/admin/cohorts/:id/instructors","Must be logged in as ADMIN","Path id: UUID of cohort. JSON field instructorId: UUID of an active instructor.",'{"instructorId":"<instructor-uuid>"}',"200 OK with the cohort's instructor list. Archived cohort, missing/suspended instructor, or duplicate assignment is rejected.","Use an active instructor who has accepted their invitation. Confirm instructor appears on cohort detail. Repeat assignment to check duplicate handling.")
add(s,"DELETE","/api/v1/admin/cohorts/:id/instructors/:instructorId","Must be logged in as ADMIN","Path id and instructorId: UUIDs. No body.","No request body.","200 OK with the remaining instructor list. Missing cohort or assignment: 404.","Remove the instructor just assigned. Repeat removal to verify the missing-assignment response.")
# applications
s="Admin application review"
add(s,"GET","/api/v1/admin/applications","Must be logged in as ADMIN","Query: page, pageSize; optional search (max 120), status (application status), preferredTrackId (UUID), from/to (valid date/time), sortBy (submittedAt or name), sortDir (asc or desc).","No request body.","200 OK with paginated application summaries.","Register a student, then filter with ?status=PENDING&page=1&pageSize=20. Use a track UUID to narrow results.")
add(s,"GET","/api/v1/admin/applications/:id","Must be logged in as ADMIN","Path id: UUID of an application.","No request body.","200 OK with submitted profile and answers. Missing record: 404.","Use the application ID from student registration or application list.")
add(s,"POST","/api/v1/admin/applications/:id/accept","Must be logged in as ADMIN","Path id: UUID of pending application. JSON required cohortId (UUID); optional note (up to 1,000 characters, admin-only).","{\"cohortId\":\"<cohort-uuid>\",\"note\":\"Accepted for the next cohort\"}","200 OK with application and enrollment. Decision/state, capacity, cohort/course, or existing enrollment conflicts are rejected.","Select an active cohort with available capacity, accept a pending application, and verify the student's dashboard/enrollment. Try a full cohort as a negative check.")
add(s,"POST","/api/v1/admin/applications/:id/decline","Must be logged in as ADMIN","Path id: UUID of pending application. Optional JSON note (up to 1,000 characters; private to admins).","{\"note\":\"Does not meet current eligibility criteria\"}","200 OK with updated application.","Decline a pending test application. Confirm the student dashboard shows declined and does not reveal the private note.")
add(s,"POST","/api/v1/admin/applications/:id/reopen","Must be logged in as ADMIN","Path id: UUID of a declined application. No body.","No request body.","200 OK with the reopened application. Only declined applications can be reopened.","Reopen the declined test application, then confirm it returns to pending. Try reopening a pending one to test rejection.")
# admin students
s="Admin student records"
add(s,"GET","/api/v1/admin/students","Must be logged in as ADMIN","Query: page, pageSize; optional search (max 120), applicationStatus, accountStatus, trackId (UUID), cohortId (UUID), sortBy (name or createdAt), sortDir (asc or desc). Track/cohort filters use the student's current active enrollment.","No request body.","200 OK with paginated student records.","Search for a registered student's name. Test applicationStatus and accountStatus. Use a valid track/cohort UUID for enrollment filtering.")
add(s,"GET","/api/v1/admin/students/:id","Must be logged in as ADMIN","Path id: UUID of a student account.","No request body.","200 OK with student profile and enrollment history. Missing record: 404.","Use the student ID returned during registration or from the student list.")
# instructor
s="Instructor cohort tools"
add(s,"GET","/api/v1/instructor/cohorts","Must be logged in as INSTRUCTOR","Query: page, pageSize; optional status (ACTIVE or ARCHIVED; default ACTIVE).","No request body.","200 OK with paginated cohorts assigned to the signed-in instructor.","Sign in as an instructor who has been assigned to a cohort. Confirm only their cohorts are returned. Try as admin; expect 403.")
add(s,"GET","/api/v1/instructor/cohorts/:id","Must be logged in as INSTRUCTOR","Path id: UUID of a cohort assigned to the signed-in instructor.","No request body.","200 OK with cohort and co-instructor names. Missing or unassigned cohort: 404.","Use an assigned cohort ID. Then use another instructor's cohort ID and confirm it returns 404.")
add(s,"GET","/api/v1/instructor/cohorts/:id/students","Must be logged in as INSTRUCTOR","Path id: UUID of a cohort assigned to the signed-in instructor. Query: page (1–100000; default 1), pageSize (1–100; default 20).","No request body.","200 OK with a paginated list of active enrolled students, including the fields allowed to instructors. Missing/unassigned cohort: 404.","Use an assigned cohort that has an accepted student. Check page=1&pageSize=1, then try an unassigned cohort.")

# Document styling

doc = Document()
section = doc.sections[0]
section.top_margin = Inches(0.65)
section.bottom_margin = Inches(0.65)
section.left_margin = Inches(0.72)
section.right_margin = Inches(0.72)
styles = doc.styles
styles['Normal'].font.name = 'Aptos'
styles['Normal']._element.rPr.rFonts.set(qn('w:eastAsia'), 'Aptos')
styles['Normal'].font.size = Pt(9)
styles['Normal'].font.color.rgb = RGBColor(40, 52, 64)
for stylename, size, color in [('Title', 30, '123B5D'), ('Heading 1', 18, '123B5D'), ('Heading 2', 12, '087E8B')]:
    st = styles[stylename]
    st.font.name = 'Aptos Display'
    st._element.rPr.rFonts.set(qn('w:eastAsia'), 'Aptos Display')
    st.font.size = Pt(size)
    st.font.bold = True
    st.font.color.rgb = RGBColor.from_string(color)

header = section.header.paragraphs[0]
header.text = 'GIRLS SET GO LMS  |  BACKEND API TESTING'
header.style = styles['Caption']
header.runs[0].font.color.rgb = RGBColor(8, 126, 139)
header.runs[0].font.bold = True
footer = section.footer.paragraphs[0]
footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
footer.add_run('Manual API Test Guide  •  ')
fld = OxmlElement('w:fldSimple'); fld.set(qn('w:instr'), 'PAGE'); footer._p.append(fld)

# Cover
title = doc.add_paragraph()
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
title.paragraph_format.space_before = Pt(70)
r = title.add_run('API MANUAL\nTEST GUIDE')
r.bold = True; r.font.name = 'Aptos Display'; r.font.size = Pt(34); r.font.color.rgb = RGBColor(18,59,93)
p = doc.add_paragraph('Every available backend route, explained in plain English')
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.runs[0].font.size = Pt(15); p.runs[0].font.color.rgb = RGBColor(8,126,139)
p = doc.add_paragraph('Prepared for manual testing  |  Route inventory: 53 endpoints')
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_before = Pt(18)
p.runs[0].font.size = Pt(10); p.runs[0].font.color.rgb = RGBColor(95,108,120)
doc.add_paragraph('')
info = doc.add_table(rows=1, cols=1)
info.alignment = WD_TABLE_ALIGNMENT.CENTER
cell = info.cell(0,0); cell.text = 'How to use this guide\nStart the API, create or obtain the required test accounts, and follow the route instructions. Each route tells you who may call it, exactly what information to send, an example request, and what a successful test should show.'
cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
for run in cell.paragraphs[0].runs:
    run.font.size=Pt(11)
    run.font.color.rgb=RGBColor(18,59,93)
shd = OxmlElement('w:shd'); shd.set(qn('w:fill'),'EAF4F6'); cell._tc.get_or_add_tcPr().append(shd)
doc.add_page_break()

# Intro

doc.add_heading('1. Start here', level=1)
doc.add_paragraph('This document lists all 53 HTTP routes registered in the backend source checked for this guide. It is configured for the deployed backend at https://girls-set-go.onrender.com. Normal API routes start with /api/v1. Health routes use /api and do not include the version number.')
doc.add_heading('Prepare your terminal', level=2)
for line in ['The API and its PostgreSQL/Redis services are hosted on Render; do not put database or Redis connection strings in requests.', 'Use the deployed backend URL shown below. If you later test a local server, change BASE_URL to your local address.', 'Save the session cookie after login and include it on routes that require sign-in.', 'Use the UUID values returned by create/list routes wherever this guide says <...-uuid>. Replace every angle-bracket placeholder before sending a request.', 'This guide targets the live deployment. Use clearly identifiable test accounts and data only. Requests that create, update, accept, decline, suspend, archive, or delete assignments affect the live database. Do not run destructive or negative state-change tests against real user data.']:
    doc.add_paragraph(line, style='List Bullet')

def add_code(text):
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Inches(0.18)
    p.paragraph_format.space_before = Pt(2); p.paragraph_format.space_after = Pt(6)
    pPr = p._p.get_or_add_pPr(); shd = OxmlElement('w:shd'); shd.set(qn('w:fill'),'F2F5F7'); pPr.append(shd)
    r = p.add_run(text); r.font.name='Menlo'; r.font.size=Pt(8); r.font.color.rgb=RGBColor(35,55,70)

add_code('export BASE_URL="https://girls-set-go.onrender.com"\nexport API="$BASE_URL/api/v1"\nexport COOKIE_JAR="/tmp/gsg-api-cookies.txt"')
doc.add_heading('Log in and save your cookie', level=2)
doc.add_paragraph('Run this with a provisioned active account. Use portal=admin for an administrator, portal=instructor for an instructor, or portal=student for a student. The portal must match the account role.')
add_code('curl -i -c "$COOKIE_JAR" "$API/auth/login" \\\n  -H "Content-Type: application/json" \\\n  --data \'{"email":"admin@example.com","password":"<your-password>","portal":"admin"}\'')
doc.add_paragraph('For a protected call, add -b "$COOKIE_JAR" to curl. A missing or invalid session usually returns 401. A logged-in user with the wrong role usually returns 403.')
doc.add_heading('Common rules that apply to many routes', level=2)
common = [
    'Do not add undocumented JSON fields or query parameters. The API rejects unknown fields with 400 Bad Request.',
    'Whenever a route asks for a UUID, use the complete ID returned by the API. A malformed UUID returns 400.',
    'Paginated lists accept page (1 to 100000; default 1) and pageSize (1 to 100; default 20). Example: ?page=1&pageSize=20.',
    'The standard paginated response contains items, page, pageSize, total, and totalPages. Public track listing is not paginated.',
    'A successful create usually returns 201. Read and edit operations usually return 200. Routes with special status codes say so below.',
    'For curl testing, omit Origin and Referer headers. If a browser sends either header on a write request, its origin must be configured.',
    'General rate limit: 100 requests per minute per IP. Login, password-link and verification routes have tighter limits; signup allows 10 requests per 10 minutes.',
    'Error responses include statusCode, error, message, path, requestId, and timestamp.'
]
for x in common: doc.add_paragraph(x, style='List Bullet')
doc.add_heading('Recommended end-to-end test order', level=2)
for x in ['Call the health routes.', 'As admin, create a track, create a course, and publish the course.', 'Register a student or create an instructor. Retrieve email links from the configured test email/outbox and complete verification/invitation.', 'Create a cohort from the published course and assign an active instructor.', 'As admin, inspect the application and accept it into the cohort. Then test the student dashboard and instructor cohort/student routes.', 'Try updates, role denials, invalid parameters, and allowed archive/restore actions.']:
    doc.add_paragraph(x, style='List Number')

# Route guide grouped by feature
current = None
for i, route in enumerate(routes, 1):
    if route['section'] != current:
        current = route['section']
        doc.add_heading(current, level=1)
    doc.add_heading(f"{i}. {route['method']} {route['path']}", level=2)
    table = doc.add_table(rows=0, cols=2)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    table.columns[0].width = Inches(1.25)
    table.columns[1].width = Inches(5.95)
    fields = [('Who can use it', route['auth']), ('Parameters', route['inputs']), ('Request body', route['body']), ('What success looks like', route['success']), ('How to test', route['test'])]
    for label, value in fields:
        cells = table.add_row().cells
        cells[0].width = Inches(1.25); cells[1].width = Inches(5.95)
        cells[0].text = label; cells[1].text = value
        for run in cells[0].paragraphs[0].runs:
            run.bold = True; run.font.color.rgb = RGBColor(18,59,93); run.font.size=Pt(8)
        for cell in cells:
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            for p in cell.paragraphs:
                p.paragraph_format.space_before=Pt(2); p.paragraph_format.space_after=Pt(3)
                for run in p.runs: run.font.size=Pt(8.2)
        shd=OxmlElement('w:shd'); shd.set(qn('w:fill'),'EAF4F6'); cells[0]._tc.get_or_add_tcPr().append(shd)
    example = route['example']
    if example is None:
        if route['method'] == 'GET':
            example = f'curl -i -b "$COOKIE_JAR" "$API{route["path"]}"'
        elif route['method'] == 'DELETE':
            example = f'curl -i -X DELETE -b "$COOKIE_JAR" "$API{route["path"]}"'
        elif route['body'] == 'No request body.':
            example = f'curl -i -X POST -b "$COOKIE_JAR" "$API{route["path"]}"'
        else:
            example = f'curl -i -b "$COOKIE_JAR" "$API{route["path"]}" -H "Content-Type: application/json" --data \'<use the JSON body described above>\''
    doc.add_paragraph('Example call (replace placeholders):', style='Caption')
    add_code(example)

# Final quick checks

doc.add_heading('Final checks for a useful manual test run', level=1)
for x in ['Call a protected route without a cookie: expect 401.', 'Call an admin route as an instructor, or an instructor route as an admin: expect 403.', 'Use an invalid UUID, invalid enum, invalid date, or unsupported field: expect 400.', 'Try a valid ID for a record that does not exist: expect 404.', 'Try a valid request that violates a state rule (for example accepting into a full cohort): expect a conflict or other documented business-rule error.', 'After logout or instructor suspension, confirm the old session cookie no longer authorizes protected requests.', 'Do not use real personal data in test accounts. Use an isolated test database and test email/outbox.']:
    doc.add_paragraph(x, style='List Bullet')
doc.add_paragraph(f'Route count: {len(routes)}. Generated for the Girls Set Go LMS backend.')

doc.save(OUTPUT)
print(f'Created {OUTPUT} with {len(routes)} route entries')
