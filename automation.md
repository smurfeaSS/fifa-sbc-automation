Build me a private local tool called **FC 27 Smart SBC Assistant**.

## Main Goal

I want a tool that works alongside the EA Sports FC 27 Web App and helps me complete Squad Building Challenges using players already inside my club.

The main priority is:

**Complete SBCs as efficiently as possible without accidentally sacrificing valuable, important, rare, or useful players.**

The tool should analyse my club, understand SBC requirements, calculate good combinations of players, and propose the safest/cheapest squad.

It should NOT blindly submit SBCs automatically.

I want to review the proposed squad first.

---

# 1. Club Scanner

The tool should be able to read the players currently inside my FC 27 Ultimate Team club when I am logged into the FC Web App.

For every player, collect as much information as is available:

* Player name
* Overall rating
* Position
* Nation
* League
* Club
* Card type
* Rarity
* Tradeable / untradeable
* Duplicate status
* Evolution status
* Special card status
* First owner
* Current squad usage
* Estimated market value if available
* Item ID
* Whether the player is manually protected

The application should build a local representation/database of my club.

Do not require my EA username/password.

The tool should operate from my already authenticated browser session where possible.

---

# 2. Protected Player System

This is extremely important.

I need a protection engine so valuable players are never accidentally used.

Players should be protectable automatically and manually.

## Automatically Protect

By default protect:

* Players in my active squad
* Players in other saved squads
* Evolution players
* Icons
* Heroes
* High-value promo cards
* Players over a configurable coin value
* Players marked as favourites
* Players I manually lock
* Rare cards I only own once
* High-rated players I choose to preserve
* Players used often in my squads

Example:

```text
Protect tradeable players worth more than 15,000 coins.
Protect all Icons.
Protect all Heroes.
Protect Evolutions.
Protect active squad players.
Protect manually locked players.
```

Allow me to change these rules.

---

# 3. Player Usage Priority

When creating SBC solutions, use players in this order.

Highest priority:

1. Duplicate untradeable players
2. Low-value untradeable players
3. Untradeable fodder
4. Cheap duplicate tradeable players
5. Cheap tradeable fodder
6. Higher-rated fodder only when necessary

Avoid protected players completely unless I explicitly override protection.

---

# 4. SBC Scanner

When I open an SBC, the tool should detect the requirements.

Examples:

* Minimum squad rating
* Exact or minimum chemistry
* Number of players
* Minimum rare players
* Minimum TOTW players
* Nation requirements
* League requirements
* Club requirements
* Player quality requirements
* Player rarity
* Item Score requirements
* Special card requirements

The tool should understand all sub-challenges inside an SBC group.

Example:

```text
Player SBC

83 Rated Squad
84 Rated Squad
84 Rated Squad + TOTW
85 Rated Squad
86 Rated Squad
```

The application should analyse all segments together rather than wasting players on the first squad.

---

# 5. Global SBC Optimization

This is one of the most important features.

Do NOT solve every squad independently.

Analyse the complete SBC first.

For example:

If an SBC requires:

```text
83
84
84 + TOTW
85
86
```

The optimizer should allocate my club players across ALL squads intelligently.

It should avoid situations where it uses my cheapest 86-rated cards inside the 84 squad and later forces me to buy expensive players for the 86 squad.

Create the globally cheapest combination.

---

# 6. Value-Aware Solver

The solver should optimise for:

1. Zero protected players used
2. Maximum duplicate usage
3. Maximum untradeable usage
4. Minimum tradeable coin value sacrificed
5. Minimum unnecessary rating excess
6. Minimum market value loss
7. Minimum purchases required

For example:

Do not submit:

```text
Rating required: 84
Calculated rating: 86.2
```

when another combination produces:

```text
Rating required: 84
Calculated rating: 84.05
```

with cheaper cards.

---

# 7. SBC Preview

Before doing anything, show me a clear preview.

Example:

## 84 Rated Squad

Required rating:
84

Calculated rating:
84.08

Players:

* Player A — 86 — untradeable
* Player B — 85 — duplicate
* Player C — 84
* Player D — 84
* etc.

Estimated value sacrificed:
8,700 coins

Tradeable value sacrificed:
1,200 coins

Untradeable value:
7,500 coins

Duplicates used:
3

Protected players used:
0

Most expensive player:
1,200 coins

Rating waste:
0.08

Status:

SAFE TO BUILD

---

# 8. Risk Warnings

The application must clearly warn me if something suspicious happens.

Examples:

```text
WARNING

This squad contains:

1 player worth approximately 45,000 coins.

Player:
XYZ

Reason included:
Required chemistry.

Recommended action:
Find alternative.
```

Other warnings:

* Valuable player detected
* Active squad player detected
* Evolution detected
* Icon detected
* Hero detected
* High-value tradeable detected
* Rare promo detected
* Protected player detected

Do not continue automatically.

---

# 9. Manual Confirmation

The workflow should be:

```text
SCAN CLUB
↓
READ SBC
↓
CALCULATE SOLUTION
↓
SHOW PREVIEW
↓
USER REVIEWS PLAYERS
↓
APPLY PLAYERS
↓
USER MANUALLY SUBMITS SBC
```

The application should never automatically press the final SBC Submit button.

I want final control.

---

# 10. Lock / Favourite System

Inside the tool I should be able to click:

```text
LOCK PLAYER
```

Locked players must never be selected.

Also allow:

```text
LOCK ALL ABOVE VALUE
LOCK ACTIVE SQUAD
LOCK EVOLUTIONS
LOCK ICONS
LOCK HEROES
LOCK PROMO CARDS
```

---

# 11. Duplicate Manager

Create a special page showing duplicate players.

Example:

```text
Duplicate Storage

89 — Player A
87 — Player B
85 — Player C
84 — Player D
83 — Player E
```

Then show:

```text
Available SBCs suitable for these duplicates
```

The tool could recommend SBCs where duplicates can be efficiently used.

---

# 12. Fodder Overview

Create an overview of my SBC fodder.

Example:

```text
90+: 3
89: 7
88: 11
87: 18
86: 24
85: 32
84: 48
83: 71
82: 94
```

Also show:

```text
Estimated fodder value:
620,000 coins
```

Separate:

* Tradeable
* Untradeable
* Duplicate
* Protected

---

# 13. SBC Cost Comparison

For every SBC calculate:

```text
Estimated market cost:
120,000 coins

Cost using my club:
31,000 tradeable coins

Untradeable value consumed:
78,000

Coins required:
11,000
```

This allows me to decide whether completing the SBC makes sense using my current club.

---

# 14. Missing Players

If my club cannot complete the SBC, identify exactly what is missing.

Example:

```text
Missing:

1 × approximately 86 rated player
2 × approximately 84 rated players

Estimated purchase cost:
13,500 coins
```

Do not just say:

```text
Cannot complete.
```

---

# 15. Cheapest Purchase Suggestions

If players must be purchased, recommend generic requirements first.

For example:

```text
Need:

1 × 86 rated card under approximately 8,000 coins
```

rather than unnecessarily forcing a specific footballer.

If market price information is available, suggest a few cheap options.

---

# 16. Local Dashboard

Build a local dashboard.

Suggested navigation:

```text
Dashboard
Club
SBC Solver
Duplicates
Fodder
Protected Players
Squads
SBC History
Settings
```

Dashboard should display:

```text
Club Players
1,847

Estimated Club Value
2.4M

Protected
74

Duplicate Fodder
18

High-Rated Fodder
126
```

---

# 17. SBC History

Record locally what was used.

Example:

```text
SBC: Player Upgrade
Date: 22/09/2026

Players Submitted: 11
Estimated Value: 17,300
Tradeable Value: 0
Duplicates Used: 4
```

Allow me to review previous SBC decisions.

---

# 18. Player Search

Allow searching:

```text
Name
Rating
League
Club
Nation
Card type
Tradeable
Untradeable
Duplicate
Value
Protected
```

Example filter:

```text
Rating >= 86
Untradeable
Not protected
```

---

# 19. Solver Modes

Include several modes.

## Maximum Savings

Minimise coin value lost.

## Duplicate Cleanup

Prioritise duplicate players.

## Untradeables Only

Never use tradeable players.

## Balanced

Best overall combination.

## Rating Efficient

Minimise rating waste.

---

# 20. Safety Mode

Create a global setting:

```text
STRICT PLAYER PROTECTION
```

When enabled:

Never use:

* Protected players
* Active squad players
* Icons
* Heroes
* Evolutions
* Special cards above my price threshold

Even if the SBC cannot otherwise be completed.

Instead tell me:

```text
SBC cannot be completed under current protection rules.
```

---

# 21. Browser Integration

Explore the safest practical architecture.

Possible options:

* Browser extension
* Tampermonkey userscript
* Local companion application
* Local web dashboard connected to browser extension

Preferred architecture:

```text
FC Web App
      ↓
Browser Extension
      ↓
Local SBC Assistant
      ↓
Local Club Database
      ↓
Optimization Engine
```

Keep as much processing local as possible.

---

# 22. Credentials and Security

Never:

* Ask for my EA password
* Store EA credentials
* Upload session cookies
* Send authentication tokens to third-party servers
* Expose browser session information

Use the existing authenticated Web App session if technically possible.

All club data should remain local unless I explicitly configure another service.

---

# 23. No Blind Automation

Do not design this as a trading bot.

Do not automatically:

* Buy players
* Sell players
* Snipe players
* Submit SBCs
* Spam Web App requests

The primary purpose is:

```text
Club Analysis
+
SBC Optimization
+
Player Protection
+
Human Confirmation
```

---

# 24. Technical Architecture

I want clean separation between modules.

Suggested architecture:

```text
/browser-extension
    club-reader
    sbc-reader
    player-injector

/dashboard
    UI
    club viewer
    SBC preview
    settings

/solver
    rating engine
    chemistry engine
    optimization engine
    value engine

/storage
    club database
    protected players
    SBC history

/shared
    player types
    SBC types
    validation
```

Prefer TypeScript.

---

# 25. Solver Algorithm

Do not use simple random card selection.

Design an actual optimization algorithm.

Possible techniques:

* Constraint satisfaction
* Integer linear programming
* Branch and bound
* Dynamic programming
* Heuristic search

The optimization function could conceptually minimise:

```text
TOTAL_COST =
tradeable_value_loss
+ rating_waste
+ protected_player_penalty
+ rare_card_penalty
+ purchase_cost
```

Protected players should effectively have an infinite penalty under Strict Protection Mode.

---

# 26. User Experience

The interface should make decisions obvious.

Use states such as:

```text
SAFE
CAUTION
EXPENSIVE
PROTECTED PLAYER DETECTED
MISSING PLAYERS
READY
```

Before applying an SBC solution I should immediately understand:

* what is being consumed
* why each player was selected
* how much value I am losing
* whether replacements exist

---

# 27. Development Strategy

Do NOT immediately start by automating Web App interactions.

Build the project in stages.

Phase 1:
Club data model.

Phase 2:
SBC requirements data model.

Phase 3:
Rating solver.

Phase 4:
Player protection engine.

Phase 5:
Value optimization.

Phase 6:
Local dashboard.

Phase 7:
Read-only Web App club detection.

Phase 8:
Read-only SBC requirement detection.

Phase 9:
Generate proposed SBC squad.

Phase 10:
Optional button to populate the squad.

Final SBC submission must remain manual.

---

# Final Objective

The finished system should behave like a personal FC 27 SBC manager.

I want to be able to open an SBC and press:

```text
OPTIMIZE USING MY CLUB
```

The application should then:

```text
1. Analyse the entire SBC.
2. Analyse my entire club.
3. Respect all protected players.
4. Prioritise duplicates and untradeables.
5. Minimise valuable tradeable cards.
6. Minimise rating waste.
7. Calculate missing players.
8. Show estimated value sacrificed.
9. Generate the best squad combination.
10. Let me inspect everything.
11. Populate the proposed players only after I approve.
12. Leave the final SBC Submit action to me.
```

The most important principle is:

**Never sacrifice a valuable player simply because its rating makes the SBC easier to complete.**

The system should optimise SBC completion around the actual value and importance of my club.
