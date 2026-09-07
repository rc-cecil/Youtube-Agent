You are the principal software architect and senior full-stack/AI engineer responsible for building a production-ready autonomous AI Gameplay Shorts Agent.

Do not build this as a demo, mockup, static dashboard, or hard-coded prototype.

Build a functional application with a real backend, persistent database, asynchronous video-processing jobs, Remotion rendering, OpenAI-powered multimodal analysis, game-specific detection, YouTube OAuth integration, YouTube upload/scheduling, YouTube Analytics ingestion, performance-learning logic, observability, retry handling, and a professional dashboard.

============================================================
1. PRODUCT VISION
============================================================

Build an application where I can upload long-form gameplay videos and largely leave the rest to the AI.

The system must:

1. Accept gameplay video uploads.
2. Determine what game is being played.
3. Analyze the actual gameplay.
4. Detect the most interesting moments.
5. Understand game-specific events.
6. Generate multiple distinctly different Short concepts.
7. Select the best moments.
8. Aggressively edit them into polished YouTube Shorts.
9. Use Remotion as the final video composition/rendering system.
10. Generate appropriate short titles.
11. Generate simple relevant hashtags.
12. Automatically upload the completed Shorts to my connected YouTube channel.
13. Schedule exactly 3 Shorts per day.
14. Publish them at:
    - 12:00 PM
    - 4:00 PM
    - 8:00 PM
15. Default scheduling timezone:
    Africa/Accra
16. Allow timezone configuration in settings.
17. Ensure the three daily Shorts have different editorial jobs/concepts.
18. Make the 8 PM Short the strongest concept of the day.
19. Learn from previous YouTube performance.
20. Adjust future clip selection, duration, hook style, content type and editing decisions based on actual performance.
21. Provide a comprehensive dashboard covering content, uploads, scheduling, analytics, performance and estimated YouTube revenue.

My target operating mode is:

30 days
× 3 Shorts/day
= 90 published Shorts

The system should be engineered to prevent missed posting days whenever sufficient approved/source content exists.

Do not claim that external APIs or services can guarantee 100% publishing uptime.

Instead build:
- queues
- pre-generation
- retries
- alerts
- backup candidates
- health monitoring
- schedule validation
- publishing reconciliation
- failure recovery

so the system aggressively works toward:

90 Shorts in 30 days
3 Shorts every day
0 preventable missed posting slots.

============================================================
2. IMPORTANT ARCHITECTURAL PRINCIPLE
============================================================

Codex is being used to BUILD this application.

Do not design the deployed production application to require an interactive Codex session.

Runtime responsibilities should be separated:

OPENAI / MULTIMODAL AI
- gameplay understanding
- candidate classification
- event understanding
- semantic ranking
- concept generation
- hook generation
- metadata generation
- performance analysis
- strategy adaptation

COMPUTER VISION / SIGNAL PROCESSING
- scene changes
- motion
- optical flow/activity
- audio energy
- HUD/score detection
- OCR
- kill feed detection where possible
- goal/result screens
- replay detection
- reaction detection
- candidate extraction

FFMPEG
- probing
- audio extraction
- transcoding
- proxy generation
- thumbnails
- frame extraction
- waveform analysis
- clip preprocessing

REMOTION
- video composition
- cropping
- reframing
- captions
- overlays
- animations
- zooms
- speed effects
- transitions
- hook text
- branding
- rendering

YOUTUBE APIs
- authentication
- uploads
- scheduling
- metadata
- channel information
- analytics
- revenue metrics where authorized

DATABASE
- source videos
- detected highlights
- AI evaluations
- concepts
- renders
- publishing queue
- YouTube videos
- analytics snapshots
- experiments
- learned strategy
- job state
- failures

============================================================
3. RECOMMENDED TECH STACK
============================================================

Use a monorepo.

Preferred architecture:

Frontend:
- React
- TypeScript
- Vite or an appropriate production React framework
- Tailwind CSS
- reusable component system
- charting library suitable for analytics dashboards

Backend:
- Node.js
- TypeScript

API:
- REST API initially
or another clean typed architecture if justified.

Database:
- PostgreSQL

ORM:
- Prisma

Job queue:
- Redis
- BullMQ or equivalent

Video processing:
- FFmpeg
- ffprobe

Rendering:
- Remotion

Storage abstraction:
- local development storage
- production object storage abstraction
- compatible with S3/R2 or equivalent

AI:
- OpenAI API

Do not hard-code model names throughout the application.

Create an AI provider abstraction and configure models through environment variables.

Example categories:
AI_REASONING_MODEL
AI_VISION_MODEL
AI_FAST_MODEL
AI_TRANSCRIPTION_MODEL

Do not assume one expensive model should perform every task.

Use a cost-efficient pipeline.

============================================================
4. PROJECT STRUCTURE
============================================================

Create a clean monorepo similar to:

apps/
    web/
    api/
    worker/
    renderer/

packages/
    db/
    ai/
    video-analysis/
    game-detectors/
    remotion/
    youtube/
    analytics/
    scheduling/
    shared/
    config/
    logger/

infra/
docs/
scripts/

You may improve this structure if there is a clear architectural reason.

============================================================
5. CORE USER FLOW
============================================================

The primary workflow must be:

UPLOAD GAMEPLAY
      ↓
VIDEO INGEST
      ↓
GENERATE PROXY
      ↓
GAME IDENTIFICATION
      ↓
SIGNAL ANALYSIS
      ↓
GAME-SPECIFIC ANALYSIS
      ↓
CANDIDATE HIGHLIGHT GENERATION
      ↓
MULTIMODAL AI ANALYSIS
      ↓
HIGHLIGHT SCORING
      ↓
DIVERSITY FILTERING
      ↓
CONCEPT CREATION
      ↓
EDITORIAL ROLE ASSIGNMENT
      ↓
SHORT EDIT PLAN
      ↓
REMOTION RENDER
      ↓
QUALITY CONTROL
      ↓
CONTENT QUEUE
      ↓
12 PM / 4 PM / 8 PM SCHEDULING
      ↓
YOUTUBE
      ↓
ANALYTICS INGESTION
      ↓
PERFORMANCE LEARNING
      ↓
FUTURE GENERATION STRATEGY

============================================================
6. VIDEO INGESTION
============================================================

Provide a proper upload interface.

Supported initial formats:
- MP4
- MOV
- WebM where practical

Validate:
- MIME type
- actual file format
- file size
- resolution
- codec
- duration
- audio presence
- corruption

Use resumable/chunked uploads for large gameplay files if practical.

Store:
- original asset
- transcoded/proxy asset
- metadata
- thumbnails
- waveform data
- extracted analysis frames

Source video state machine:

UPLOADED
PROCESSING
ANALYZING
READY
FAILED
ARCHIVED

Show progress in the UI.

============================================================
7. GAME IDENTIFICATION
============================================================

Automatically attempt to identify the game.

Examples include:

GTA V
GTA VI
EA Sports FC / FIFA
Call of Duty
Warzone
Fortnite
Valorant
Apex Legends
Minecraft
Rocket League
NBA 2K
other games

Use:
- sampled frames
- visual UI/HUD
- OCR
- image understanding
- optional user hint

Return:

game
confidence
version/edition if recognizable
detector profile used

If confidence is low:
use generic gameplay analysis rather than hallucinating.

Allow the user to override detected game.

============================================================
8. PLUGGABLE GAME-SPECIFIC DETECTION
============================================================

Create a GameDetector interface.

Example:

interface GameDetector {
    detectSignals(...)
    detectEvents(...)
    scoreEvents(...)
    enrichCandidates(...)
}

Implement:

GenericGameplayDetector

and create initial adapters for:

FCDetector
GTADetector
CODDetector
FortniteDetector

The architecture must make it straightforward to add new games.

============================================================
9. FC / FIFA / EA SPORTS FC DETECTION
============================================================

Look for signals including:

- goals
- score changes
- penalties
- penalty saves
- red cards
- spectacular saves
- shots hitting posts/bar
- skill sequences
- dribbles
- counterattacks
- late goals
- winners
- equalizers
- comebacks
- celebrations
- replay sequences
- final whistle
- rage reactions
- funny misses
- unusual gameplay events

Strongly boost:

late winners
comeback goals
long-range goals
unexpected goals
penalty drama
high-skill sequences
rage/funny reactions

============================================================
10. GTA DETECTION
============================================================

Look for:

- crashes
- explosions
- police chases
- near misses
- funny NPC behavior
- unexpected physics
- stunts
- shootouts
- vehicle escapes
- bizarre deaths
- mission failures
- mission victories
- funny dialogue
- chaotic situations
- unexpected events
- spectacular driving
- wanted-level escalation

Do not assume every explosion is a highlight.

Context matters.

============================================================
11. COD / WARZONE DETECTION
============================================================

Look for:

- multi-kills
- streaks
- clutches
- squad wipes
- snipes
- long shots
- fast reaction kills
- last-player-standing sequences
- near death escapes
- wins
- gulag wins
- loadout moments
- funny deaths
- rage reactions
- surprising enemy encounters
- high-intensity firefights

============================================================
12. FORTNITE DETECTION
============================================================

Look for:

- eliminations
- multi-eliminations
- victories
- final-circle situations
- build battles
- edit plays
- impressive shots
- escapes
- funny deaths
- unexpected player behavior
- clutch heals
- low-health victories
- reaction moments

============================================================
13. MULTI-SIGNAL HIGHLIGHT DETECTION
============================================================

Do NOT ask the expensive AI model to watch every frame of a 4-hour video.

Build a hierarchical pipeline.

Stage A — inexpensive preprocessing

Detect:
- cuts
- scene changes
- motion/activity
- audio volume
- sudden audio peaks
- silence
- music/activity changes
- OCR changes
- HUD changes
- scoreboard changes where applicable

Stage B — candidate generation

Combine nearby signals into possible interesting windows.

Example candidate:

start = 17:42
event = 17:54
end = 18:10

Include context before and payoff after.

Stage C — sampled multimodal analysis

Extract representative frames/clips around candidates.

Ask AI to understand:
- what happened
- whether it makes sense without the full video
- excitement
- surprise
- skill
- humor
- tension
- emotional payoff
- visual clarity
- replay value
- social-share potential

Stage D — candidate scoring.

============================================================
14. HIGHLIGHT SCORING
============================================================

Every candidate should receive scores including:

eventImportance
excitement
surprise
skill
humor
tension
emotionalReaction
visualClarity
contextIndependence
hookPotential
retentionPotential
sharePotential
novelty
editability
confidence

Calculate:

highlightScore: 0-100

Store explanations separately.

Do not expose giant AI chain-of-thought outputs.

Store concise reasoning such as:

"Late winning goal + immediate reaction + replay."

or:

"Three-kill clutch with clear beginning and payoff."

============================================================
15. SHORT LENGTH
============================================================

DO NOT automatically make every Short 50-60 seconds.

Duration must be content-driven.

Possible examples:

8 seconds
12 seconds
17 seconds
23 seconds
31 seconds
38 seconds
46 seconds
55 seconds

The AI must answer:

"What is the shortest duration that preserves the setup, action and payoff?"

Prefer tight edits.

Cut:
- loading
- menus
- waiting
- dead air
- repetitive traversal
- unnecessary setup
- duplicated replay footage
- irrelevant conversation

But do not cut so aggressively that the viewer cannot understand what happened.

Optimize for:

HOOK
→ CONTEXT
→ ESCALATION
→ PAYOFF
→ END

Avoid unnecessary outro padding.

============================================================
16. THE FIRST SECOND IS CRITICAL
============================================================

Treat the opening 1 second as prime real estate.

Do not routinely begin with:

"Hey guys..."
"Watch until the end"
"So today..."
generic logo animations
slow fades
black frames
loading screens

Start with:

- immediate action
- anticipation
- an outcome tease
- reaction
- unusual visual
- provocative context
- tension
- curiosity

Examples:

"90TH MINUTE..."
"HOW DID THAT GO IN?"
"I THOUGHT I WAS DEAD 💀"
"WORST MISS OF MY LIFE"
"1 HP."
"THIS NPC IS BROKEN 😭"

Do NOT generate misleading clickbait.

The opening must accurately relate to the clip.

============================================================
17. AGGRESSIVE EDITING
============================================================

Editing should be energetic where appropriate.

Implement support for:

- jump cuts
- dead-air removal
- punch-in zoom
- dynamic crop
- impact zoom
- freeze frame
- replay
- short slow motion
- speed ramps
- shake only when justified
- flash only when justified
- impact text
- arrows
- circles/highlights
- crop tracking
- reaction emphasis
- audio ducking
- audio normalization
- sound effects
- progress elements
- intentional hard cuts

Avoid:

- excessive random transitions
- constant zooming
- unnecessary effects
- overstimulation
- covering important HUD information
- giant captions blocking gameplay

Effects should increase comprehension or excitement.

============================================================
18. 16:9 → 9:16 SMART REFRAMING
============================================================

Gameplay is usually landscape.

Output must be:

1080 × 1920
9:16

Build a smart reframing engine.

Prioritize:
- player/character
- enemies
- ball
- crosshair
- important UI
- vehicles
- objectives
- reaction webcam if present

Allow multiple strategies:

CENTER
SMART_CROP
TRACKED_CROP
STACKED
BACKGROUND_BLUR
GAMEPLAY_PLUS_FACE_CAM

Detect when cropping would remove essential information.

If so, switch strategy.

============================================================
19. CAPTIONS — SELECTIVE, NOT AUTOMATIC
============================================================

Do NOT cover every second of every video in giant captions.

Captions should be used selectively.

Use captions when:
- commentary matters
- reactions matter
- dialogue is important
- the viewer needs context

Do not caption:
- gunshots
- crowd noise
- engine sounds
- meaningless filler
- every game sound

Support:
- phrase captions
- word highlighting
- emphasis
- line breaking
- safe zones

Keep captions mobile readable.

============================================================
20. AUDIO
============================================================

Preserve important original gameplay audio.

Normalize levels.

Handle:
- game sound
- voice commentary
- microphone
- sound effects
- optional music

Speech should remain intelligible.

Do not overwhelm the original clip with unnecessary music.

============================================================
21. CONCEPT GENERATION
============================================================

A highlight is NOT automatically a Short.

A highlight can produce one or more editorial concepts.

Example FC event:

raw event:
late winner

possible concepts:

A:
"90TH MINUTE WINNER 😭"

B:
"I SHOULD NOT HAVE SHOT FROM THERE"

C:
"FROM 2-0 DOWN..."

D:
"The goalkeeper had NO chance."

The AI should select the concept most appropriate to the event.

============================================================
22. DAILY THREE-VIDEO EDITORIAL SYSTEM
============================================================

Exactly three posting slots:

12:00 PM
4:00 PM
8:00 PM

The three daily videos must NOT feel nearly identical.

They should have different editorial jobs.

Create these roles:

12 PM — DISCOVERY
Goal:
easy-to-understand, immediate, accessible clip.

Examples:
funny moment
quick skill
crazy miss
short surprising event
fast payoff

Generally:
shorter
low context requirement
high instant comprehension

-----------------------------------

4 PM — ENGAGEMENT
Goal:
generate comments/shares/reactions.

Examples:
controversial play
funny fail
challenge
close call
rage moment
debate-worthy event
unusual strategy

-----------------------------------

8 PM — HERO
This should be the strongest concept available that day.

Goal:
maximize likelihood of major reach.

Examples:
best clutch
craziest goal
huge comeback
spectacular sequence
funniest exceptional moment
high-emotion sequence
strong story arc

The 8 PM video gets first choice from the highest-quality candidate pool.

DO NOT simply take the three highest scores and post them chronologically.

Build a DailySlatePlanner.

============================================================
23. CONTENT DIVERSITY ENGINE
============================================================

Videos posted after each other must not be nearly identical.

Create similarity scoring using:

- source video
- timestamps
- game
- event type
- detected objects
- transcript
- semantic embedding
- visual similarity
- hook
- title
- duration
- editing template
- emotional tone

Create:

similarityScore = 0-1

Prevent adjacent videos exceeding a configurable threshold.

Example:

Do not publish:

12 PM:
GTA police chase

4 PM:
another almost-identical GTA police chase

8 PM:
another police chase from the same 10-minute section

Prefer:

12 PM:
funny NPC glitch

4 PM:
failed stunt

8 PM:
five-star police escape

Even if all three are GTA.

============================================================
24. SOURCE VIDEO DISTRIBUTION
============================================================

Avoid exhausting one source video immediately.

Track how many Shorts have been created from each source.

Prevent excessive reuse of:
- same scene
- same match
- same sequence
- same moment
- same hook

Allow intentional multipart sequences only when justified.

============================================================
25. TITLE GENERATION
============================================================

Generate SHORT titles.

Do not create SEO-stuffed essay titles.

Examples:

90TH MINUTE 😭
NO WAY THAT WORKED
1 HP CLUTCH
HE ACTUALLY MISSED 💀
GTA PHYSICS 😭
HOW DID I SURVIVE?
WHAT A GOAL.
BRO WAS LOST 💀

Rules:

- short
- accurate
- readable
- curiosity-oriented
- relevant to clip
- minimal unnecessary punctuation
- no fake claims
- no hashtag spam inside title

Generate multiple title candidates.

Select the strongest one.

============================================================
26. HASHTAGS
============================================================

Keep hashtags simple.

Usually use only a few highly relevant tags.

Examples:

#gaming #shorts

#gta #gta5 #gaming

#gta6 #gaming #shorts

#eafc #fc26 #gaming

#cod #warzone #gaming

Do not produce giant keyword blocks.

Determine hashtags from:
- detected game
- actual content
- current metadata configuration

Create settings allowing me to define preferred and banned hashtags.

============================================================
27. METADATA
============================================================

For each rendered Short generate:

title
description
hashtags
game
eventType
concept
editorialRole
sourceVideoId
sourceTimestamp
duration
confidence
quality score

Keep the description simple.

============================================================
28. REMOTION SYSTEM
============================================================

Use Remotion as the final composition engine.

If Remotion skills/plugin documentation is available to the coding environment, use it.

Otherwise implement Remotion normally using official packages.

Create reusable compositions/components.

Suggested components:

GameplayShort
GameplayVideo
SmartCrop
TrackedCrop
HookText
CaptionLayer
ImpactText
ProgressBar
FacecamLayout
ReplaySequence
SlowMotionSequence
ZoomSequence
AudioMixer
SoundEffect
ChannelBranding
CTA
DebugOverlay

Use declarative props.

Example:

{
  sourceVideo,
  startFrame,
  endFrame,
  cropStrategy,
  trackedSubject,
  hook,
  captions,
  effects,
  audio,
  replay,
  branding
}

Do not hardcode a single video.

============================================================
29. EDIT DECISION LIST
============================================================

Before rendering, AI should create a structured EditDecisionList.

Example:

{
  clipStart,
  clipEnd,
  outputDuration,
  hook: {...},
  cuts: [...],
  zooms: [...],
  freezeFrames: [...],
  replay: {...},
  captions: [...],
  overlays: [...],
  cropStrategy,
  audioInstructions: [...],
  title,
  hashtags
}

Validate this schema before rendering.

The renderer should operate on structured instructions, not unstructured AI text.

============================================================
30. QUALITY CONTROL
============================================================

Before scheduling:

validate:
- render completed
- video playable
- correct resolution
- correct aspect ratio
- correct duration
- audio exists when expected
- no black opening
- no black ending
- hook visible/readable
- safe-area validation
- captions do not overflow
- no duplicate render
- no duplicate moment
- title present
- metadata present
- no excessively similar adjacent Short
- source has publishing rights flag

Create states:

DRAFT
ANALYZING
SELECTED
EDIT_PLANNED
RENDERING
QC
READY
SCHEDULED
UPLOADED
PUBLISHED
FAILED

============================================================
31. CONTENT REVIEW MODES
============================================================

Support two modes.

MANUAL APPROVAL

AI generates Shorts but I approve them before publishing.

AUTOPILOT

AI can select, render and schedule automatically.

Allow settings:

autopilotEnabled
minimumHighlightScore
minimumConfidence
minimumQualityScore

If below threshold:
send to manual review.

============================================================
32. YOUTUBE AUTHENTICATION
============================================================

Implement Google OAuth securely.

Request only required scopes.

Never store Google passwords.

Store tokens securely.

Support:
- connect channel
- disconnect channel
- reconnect/re-auth
- token refresh
- expired token handling

Show connected:
channel
avatar
channel ID
subscriber information where available

============================================================
33. YOUTUBE UPLOAD
============================================================

Use the official YouTube Data API.

Use resumable upload.

Each scheduled Short should:

1. render locally/cloud
2. pass QC
3. upload as private
4. set metadata
5. schedule publication using the supported publishing timestamp functionality
6. save the returned YouTube video ID
7. verify the scheduled state

Do not assume a successful HTTP request guarantees eventual publication.

Implement reconciliation jobs.

============================================================
34. SCHEDULING SYSTEM
============================================================

Create a proper scheduling engine.

Default timezone:
Africa/Accra

Daily slots:

12:00
16:00
20:00

The system must maintain a rolling content buffer.

Target:
minimum 3-7 days of READY or SCHEDULED Shorts.

Example:

TODAY:
12 PM ready
4 PM ready
8 PM ready

TOMORROW:
12 PM ready
4 PM ready
8 PM ready

NEXT DAY:
...

Do not wait until 11:59 AM to create the noon video.

Pre-render and pre-schedule whenever possible.

============================================================
35. 30-DAY / 90-SHORT CAMPAIGN
============================================================

Allow creation of a campaign:

Campaign:
90 Shorts in 30 days

startDate
endDate
timezone
videosPerDay = 3
postingTimes = 12:00, 16:00, 20:00

Display:

Goal:
90

Published:
42

Scheduled:
21

Ready:
17

Missing slots:
10

Days remaining:
16

Completion forecast:
93%

Create a 30-day schedule grid.

============================================================
36. MISSED-SLOT PREVENTION
============================================================

This is critical.

Implement:

1. publishing watchdog
2. queue health checks
3. preflight checks
4. render retries
5. upload retries
6. OAuth health check
7. YouTube schedule verification
8. backup Short candidates
9. emergency replacement publishing
10. notifications

Example:

If the planned 4 PM Short fails QC at 2 PM:

select backup candidate
→ render
→ QC
→ upload
→ preserve the 4 PM slot

If publishing fails:
retry using exponential backoff where appropriate.

Do not duplicate uploads blindly.

Use idempotency keys.

============================================================
37. YOUTUBE ANALYTICS INGESTION
============================================================

Connect to YouTube Analytics.

Create recurring analytics sync jobs.

Collect accessible metrics including:

views
engaged views
watch time
average view duration
average percentage viewed when available
likes
comments
shares
subscribers gained
subscribers lost

Collect additional Shorts/channel metrics where supported.

Do not invent metrics that the API does not provide.

Store daily snapshots.

============================================================
38. REVENUE DASHBOARD
============================================================

Where the connected account has appropriate monetization access, retrieve accessible YouTube revenue metrics.

Show:

Estimated YouTube Revenue

Today
Last 7 days
Last 28 days
This month
Lifetime captured by system

Include:

estimatedRevenue
estimatedAdRevenue
Premium revenue where supported
monetized playbacks where supported
CPM/RPM-like metrics where supported or derivable appropriately

Clearly label monetary numbers as ESTIMATED when returned as estimated values.

Do not present estimated revenue as final payout.

Allow:
USD
GHS display

If currency conversion is implemented:
store exchange rate source and timestamp.

If revenue metrics are unavailable:
display:

"Revenue data unavailable. The connected channel may not have access to monetary analytics or may not currently be monetized."

Never fabricate zero revenue when the API simply did not authorize the metric.

============================================================
39. DASHBOARD
============================================================

Create a polished creator dashboard.

Main page:

-----------------------------------------
CHANNEL OVERVIEW

Subscribers
Views
Watch Time
Estimated Revenue
Shorts Published
Shorts Scheduled
Current campaign progress

-----------------------------------------
TODAY

12 PM
Published / Scheduled / Missing

4 PM
Published / Scheduled / Missing

8 PM
Published / Scheduled / Missing

-----------------------------------------
TOP PERFORMING SHORTS

title
thumbnail
views
engaged views
avg view duration
retention
likes
shares
subscribers gained
estimated revenue where available

-----------------------------------------
AI INSIGHTS

Examples:

"17-24 second GTA clips are outperforming longer clips."

"Police chase content has 1.8× your average views."

"Videos opening directly on the impact are retaining viewers better."

"FC comeback clips are generating more shares."

"8 PM videos are outperforming noon videos."

-----------------------------------------

============================================================
40. DASHBOARD PAGES
============================================================

Implement:

/dashboard

/uploads

/library

/highlights

/shorts

/calendar

/queue

/analytics

/revenue

/experiments

/ai-insights

/settings

/settings/youtube

/settings/ai

/settings/rendering

/settings/scheduling

============================================================
41. CONTENT LIBRARY
============================================================

Show all source videos.

For each source:

thumbnail
filename
game
duration
upload date
analysis status
highlights detected
Shorts generated
Shorts published
remaining candidate highlights

Open source detail page:

timeline
detected events
scores
generated Shorts
used regions
unused regions

============================================================
42. SHORT DETAIL PAGE
============================================================

Display:

preview
source
timestamp
game
event
highlight score
AI explanation
concept
editorial role
duration
hook
title
hashtags
edit plan
render status
YouTube state
analytics

Buttons:

Preview
Re-render
Edit metadata
Approve
Reject
Schedule
Publish
Replace
Archive

============================================================
43. PERFORMANCE LEARNING ENGINE
============================================================

This is one of the most important systems.

The AI must learn from the channel's OWN results.

Do NOT train a foundation model.

Build a recommendation/performance layer using historical data.

Track features such as:

game
eventType
duration
postingTime
dayOfWeek
hookType
openingFrameStyle
captionStyle
captionUsage
editIntensity
facecamPresence
titleLength
emojiUsage
hashtagSet
sourceType
concept
editorialRole
audio characteristics

Track outcomes:

views after 1h
views after 6h
views after 24h
views after 72h
views after 7d
engaged views
watch duration
retention
likes
comments
shares
subs gained
revenue

Normalize performance relative to:
- channel baseline
- game
- posting slot
- age of video

============================================================
44. CONTENT PERFORMANCE SCORE
============================================================

Create configurable scoring.

Example:

performanceScore =
    retentionWeight
  + engagedViewsWeight
  + shareWeight
  + subscriberWeight
  + velocityWeight

Do not optimize exclusively for raw views.

A clip with:
100K views
but poor retention

may be less strategically valuable than:

60K views
high completion
high shares
high subscriber conversion

============================================================
45. FEEDBACK LOOP
============================================================

The agent should periodically generate strategy updates.

Example:

INSIGHT:
GTA clips between 14-22 seconds have produced
+31% higher completion rates.

ACTION:
increase selection weight for tight GTA moments.

INSIGHT:
Generic caption-heavy videos underperform.

ACTION:
reduce captions unless commentary matters.

INSIGHT:
Funny failure clips at noon perform strongly.

ACTION:
increase noon DISCOVERY weighting.

INSIGHT:
Clutches outperform funny moments at 8 PM.

ACTION:
favor clutch/HERO content at 8 PM.

Store recommendations.

Do NOT modify strategy without auditability.

Track:
previous value
new value
reason
metrics used
timestamp

============================================================
46. EXPLORATION VS EXPLOITATION
============================================================

Do not generate only one type of Short forever.

Use an exploration strategy.

Example:

70-80%
proven formats

20-30%
experiments

Experiments might test:

duration
hook
caption style
edit style
event category
posting slot
title structure

Create an Experiments page.

============================================================
47. AVOID FALSE LEARNING
============================================================

Do not decide:

"17-second clips are best"

after one successful video.

Require minimum evidence.

Use:
sample sizes
confidence
rolling windows
recency
outlier detection

Show confidence:

LOW
MEDIUM
HIGH

============================================================
48. 8 PM HERO SELECTION
============================================================

The 8 PM slot must be deliberately protected.

Daily planning should happen before noon.

Reserve the strongest candidate for 8 PM.

HeroScore could consider:

highlight score
historical category performance
hook potential
story strength
emotional payoff
novelty
predicted retention
predicted engagement
predicted subscriber conversion

Do not accidentally publish the best clip at noon simply because it was rendered first.

============================================================
49. NO NEAR-DUPLICATE POSTS
============================================================

Implement duplicate protection.

Check:

perceptual frame hashes
source timestamp overlap
semantic similarity
event type
title similarity
hook similarity
visual similarity

Block:

same moment with slightly different crop
same goal twice
same kill sequence twice
same source segment twice

unless explicitly marked as:
REPLAY
PART_2
ALTERNATE_EDIT

============================================================
50. AI COST CONTROL
============================================================

Video analysis can become expensive.

Design for cost efficiency.

Do not send entire long videos repeatedly to expensive models.

Pipeline:

cheap processing
→ candidate narrowing
→ sampled multimodal inspection
→ expensive reasoning only for finalists

Cache AI results.

Use hashes.

Never reanalyze unchanged files unnecessarily.

Dashboard should track:

estimated AI cost
render cost
storage usage
processing time

============================================================
51. DATABASE MODELS
============================================================

Create proper entities including:

User
YouTubeConnection
Channel
SourceVideo
VideoAsset
AnalysisJob
GameDetection
DetectedEvent
HighlightCandidate
HighlightScore
ShortConcept
EditDecisionList
RenderedShort
ScheduleSlot
YouTubePublication
AnalyticsSnapshot
RevenueSnapshot
PerformanceFeature
PerformanceInsight
Experiment
StrategyConfig
Campaign
JobRun
FailureEvent
Notification

Design relations carefully.

============================================================
52. SECURITY
============================================================

Implement:

environment validation
OAuth security
encrypted token storage
secure cookies
CSRF protections where needed
rate limits
signed upload URLs if using object storage
file validation
safe FFmpeg invocation
no shell injection
access control
audit logs
secret management

Never expose:

OpenAI API key
Google client secret
refresh tokens
storage credentials

to browser code.

============================================================
53. RIGHTS / CONTENT OWNERSHIP
============================================================

Before autopublishing, require a setting/checkbox confirming:

"I own this footage or have the necessary permission to publish it."

Store the acknowledgement.

Do not create a system designed around ripping arbitrary copyrighted YouTube videos.

Uploaded source footage is the primary intended workflow.

============================================================
54. ERROR HANDLING
============================================================

Every asynchronous operation should support:

PENDING
RUNNING
SUCCEEDED
FAILED
RETRYING
CANCELLED

Store:

errorCode
errorMessage
attempt
createdAt
updatedAt

Provide admin-friendly errors.

Never leave a UI spinner permanently running.

============================================================
55. OBSERVABILITY
============================================================

Implement structured logs.

Track:

upload time
analysis time
AI calls
render duration
render failures
YouTube upload duration
publish failures
analytics sync
job queue depth

Dashboard health page:

AI
database
Redis
renderer
storage
YouTube OAuth
YouTube API
scheduler
workers

============================================================
56. NOTIFICATIONS
============================================================

Support application notifications first.

Generate alerts for:

source processing failure
render failure
scheduled slot missing
YouTube auth expired
upload failure
publication failure
analytics sync failure
content queue running low

Future architecture may support:
email
Slack
push

============================================================
57. CALENDAR
============================================================

Create visual monthly/weekly calendar.

Every scheduled video card shows:

thumbnail
title
game
editorial role
time
status

Use different indicators for:

READY
SCHEDULED
PUBLISHED
FAILED
MISSING

Allow drag/drop rescheduling only if safe.

============================================================
58. QUEUE HEALTH
============================================================

Display:

Ready Shorts: 19
Scheduled: 15
Days of buffer: 5
Missing slots: 0

Health:

GREEN
>= 3 days buffer

YELLOW
1-2 days

RED
< 1 day

Autopilot should prioritize restoring buffer when health falls.

============================================================
59. SEARCH AND FILTERING
============================================================

Allow filtering Shorts by:

game
event
source
date
duration
status
editorial role
performance
posting time

============================================================
60. ANALYTICS COMPARISONS
============================================================

Dashboard should answer questions such as:

Which game gets the most views?

Which game produces the best retention?

What Short duration performs best?

Does 12 PM, 4 PM or 8 PM perform best?

Which event type performs best?

Do captions help?

Does aggressive editing help?

Do emoji titles help?

Which hooks perform best?

What generates subscribers?

What generates revenue?

What should the agent generate more of?

============================================================
61. AI INSIGHT FORMAT
============================================================

Each insight should contain:

finding
evidence
sample size
confidence
recommended action

Example:

Finding:
GTA police chase clips between 18-27 seconds outperform the channel baseline.

Evidence:
Average 24h views +42%
Average watch percentage +11%

Sample:
12 Shorts

Confidence:
MEDIUM

Recommendation:
Increase GTA police-chase candidate weighting by 15%.

============================================================
62. DO NOT CHASE ONLY RECENT OUTLIERS
============================================================

Use rolling analysis windows:

7 days
28 days
90 days
lifetime

Weight recent performance more strongly while retaining historical context.

============================================================
63. PREDICTIVE RANKING
============================================================

Once sufficient data exists, calculate a predicted score for new candidates.

Inputs might include:

game
event
duration
hook
editing profile
posting slot
historical category performance
source novelty

Call:

predictedPerformanceScore

This is a ranking signal only.

Do not claim certainty.

============================================================
64. YOUTUBE DATA SYNCHRONIZATION
============================================================

Build scheduled jobs such as:

published video refresh:
frequent initially

analytics:
periodic batch refresh

long-term analytics:
less frequent

Store snapshots rather than overwriting history.

Use idempotent synchronization.

============================================================
65. REVENUE ATTRIBUTION
============================================================

Where revenue is available, allow:

estimated revenue by:
day
video
game
event type
duration bucket
posting slot
editorial role

Display:

Revenue per 1,000 views where correctly derivable

Do not call a calculated metric an official YouTube metric if it is internally derived.

============================================================
66. SETTINGS
============================================================

Create configurable settings for:

timezone
posting times
daily quantity
autopilot
minimum quality
minimum highlight score
minimum confidence
preferred games
banned event categories
caption policy
branding
render quality
hashtags
YouTube privacy workflow
AI cost ceiling
content buffer target
duplicate threshold
exploration rate

Although defaults are:

12 PM
4 PM
8 PM
3 videos/day

do not hard-code them throughout the system.

============================================================
67. BRANDING SETTINGS
============================================================

Allow:

channel name
logo
watermark
font
caption style
hook style
CTA
safe zone
branding intensity

Do not force branding into every second.

============================================================
68. PREVIEW
============================================================

Before publication, allow:

full vertical preview
timeline preview
metadata preview

Provide:

Approve
Reject
Regenerate edit
Generate new hook
Generate new title
Shorten
Lengthen
Reduce captions
Increase intensity

============================================================
69. RENDER PIPELINE
============================================================

Use workers.

Do not perform long Remotion rendering in API request threads.

API:
creates render job

Worker:
renders

Storage:
stores final MP4

Database:
updates state

Frontend:
polls/subscribes for progress

============================================================
70. TESTING
============================================================

Write:

unit tests
integration tests
API tests
scheduler tests
duplicate detection tests
highlight scoring tests
Remotion render smoke tests
YouTube integration mocks
OAuth tests
job retry tests

Especially test scheduling:

11:59 boundary
timezone
DST-safe architecture
month change
failed 4 PM upload
duplicate job execution
worker restart

============================================================
71. DEVELOPMENT MODE
============================================================

The complete application must run without real YouTube publication initially.

Create:

YOUTUBE_MODE=mock

Mock:
uploads
analytics
revenue
publishing

Create realistic fixture data.

Then support:

YOUTUBE_MODE=live

============================================================
72. REMOTION DEVELOPMENT MODE
============================================================

Provide sample gameplay fixtures or documented placement.

Allow:

npm run remotion:studio

or equivalent.

Provide compositions that work with sample/mock assets.

============================================================
73. LOCAL SETUP
============================================================

Create:

README.md
.env.example
docker-compose.yml

Provide commands for:

install
database setup
migrations
Redis
API
frontend
worker
Remotion Studio
tests
production build

============================================================
74. ENVIRONMENT VARIABLES
============================================================

Document variables such as:

DATABASE_URL
REDIS_URL

OPENAI_API_KEY

GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI

YOUTUBE_MODE

STORAGE_PROVIDER
STORAGE_BUCKET

APP_URL
API_URL

ENCRYPTION_KEY

AI_REASONING_MODEL
AI_VISION_MODEL
AI_FAST_MODEL

TIMEZONE

Do not commit secrets.

============================================================
75. IMPLEMENTATION PHASES
============================================================

Do not attempt to build everything in one giant untested change.

Implement sequentially.

PHASE 1
Foundation
- monorepo
- database
- auth
- uploads
- storage
- FFmpeg metadata
- job queue
- dashboard shell

PHASE 2
Video analysis
- proxy
- scene/audio/motion analysis
- candidates
- game identification
- generic detector

PHASE 3
Game intelligence
- FC
- GTA
- COD
- Fortnite
- AI candidate ranking

PHASE 4
Short creation
- concepts
- EDL
- Remotion
- vertical reframing
- captions
- effects
- rendering
- preview

PHASE 5
Editorial intelligence
- daily slate
- diversity
- Hero selection
- duplicate prevention

PHASE 6
YouTube
- OAuth
- upload
- scheduling
- metadata
- reconciliation

PHASE 7
Analytics
- YouTube Analytics
- snapshots
- dashboard
- revenue

PHASE 8
Learning
- feature extraction
- performance comparisons
- insights
- strategy adjustment
- experimentation

PHASE 9
Production hardening
- retries
- watchdogs
- observability
- alerts
- security
- deployment
- tests

After every phase:

1. run tests
2. run type checks
3. run linting
4. fix errors
5. update documentation
6. commit logically

============================================================
76. ACCEPTANCE TEST
============================================================

The finished MVP must support this scenario:

I open the app.

I connect my YouTube channel.

I upload:

GTA-gameplay-01.mp4
FC-gameplay-02.mp4
COD-gameplay-03.mp4

The system:

1. processes all files
2. identifies each game
3. detects candidate moments
4. ranks them
5. creates varied concepts
6. selects a daily slate
7. reserves the strongest concept for 8 PM
8. renders vertical Shorts
9. creates short titles
10. adds only relevant hashtags
11. performs quality control
12. displays previews
13. schedules:
    12 PM
    4 PM
    8 PM
14. publishes through YouTube
15. records YouTube video IDs
16. retrieves analytics
17. displays performance
18. retrieves estimated revenue where authorized
19. determines which patterns are working
20. updates future content-ranking recommendations

After sufficient uploaded footage is available, I should be able to create:

30-day campaign
90 Shorts
3/day

and inspect:

published
scheduled
ready
failed
missing
performance
revenue

from the dashboard.

============================================================
77. QUALITY STANDARD
============================================================

Do not:

- fake functionality
- use placeholder buttons
- fake analytics
- fake AI analysis
- fake publishing
- hard-code successful responses
- leave TODOs for core requirements
- claim an integration exists when it does not
- bypass TypeScript errors
- disable tests to get a green build
- store secrets in source control

If an external API requires credentials that are not present:

implement the integration fully
create environment variables
create mock development mode
document exact setup steps

Then continue building everything that does not require the credential.

============================================================
78. BEFORE WRITING CODE
============================================================

First inspect the existing repository.

Then produce:

1. architecture assessment
2. proposed directory structure
3. database schema plan
4. job architecture
5. AI pipeline
6. Remotion pipeline
7. YouTube integration design
8. analytics design
9. implementation milestones
10. known risks

Do not rebuild existing working functionality unnecessarily.

After presenting the plan, begin implementation.

Continue autonomously through the phases.

Do not stop after merely generating the architecture document.

============================================================
79. FINAL SUCCESS CONDITION
============================================================

I want this application to behave like an autonomous gaming-content team:

AI HIGHLIGHT SCOUT
finds the moments

AI GAME ANALYST
understands what happened

AI CONTENT STRATEGIST
chooses the concept

AI EDITOR
creates the edit plan

REMOTION
renders the video

AI COPYWRITER
creates title + simple hashtags

AI PROGRAMMER / SCHEDULER
maintains the content calendar

YOUTUBE INTEGRATION
publishes the Shorts

AI ANALYST
measures performance

AI GROWTH STRATEGIST
learns what works

The system should continuously make better evidence-based content decisions as the channel accumulates performance data.

Build it accordingly.

