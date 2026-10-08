# ClipForge Bot — Setup & User Guide

Canonical Telegraph copy: https://telegra.ph/ClipForge-Bot--Setup--User-Guide-08-27

This file records the published guide so future sessions can update and re-post it.
Content is authored against the live bot UI (bot/src/views.js, commands/*, runtime.js).

## bug-29 (this sweep)
The previous page (…Complete-User-Guide-08-27-2) was replaced:
- **Added** full onboarding: (1) create a GitHub account, (2) set up the repository via
  the bot's "Create private Shadow Clone" / "Connect existing clone" flow, (3) create a
  classic GitHub PAT with the minimum scopes `repo` + `workflow`, including an ASCII
  diagram of the flow.
- **Removed** all embedded images/screenshots (they were placehold.co mockups, not done
  properly). The page is now text-only with ASCII art where a visual helps.

## Edit access (keep secret — do not commit elsewhere / do not share publicly)
- access_token (page edit): 5e479bb63ae1fda05052c98d049124ea1c5052556c8bd42f23d896695527
- Edit endpoint: https://api.telegra.ph/editPage (POST access_token, path, title, content)

## Current page outline
1. Create a GitHub account
2. Set up the repository (the clone)
3. Create a GitHub PAT (repo + workflow)  [ASCII diagram]
4. Starting a video — /new
5. Stage A then Stage B
6. When the task finishes
7. Commands
Good to know

## YouTube video sources & optional YOUTUBE_COOKIES secret

ClipForge supports ingesting public YouTube videos directly:
- **Supported links**: `youtube.com/watch?v=...`, `youtu.be/...`, `youtube.com/shorts/...`, `m.youtube.com`, `music.youtube.com` (video pages).
- **Parameters**: Playlist and radio mix parameters (`list=`, `index=`, `start_radio=`) are automatically stripped, ingesting only the chosen video.
- **Limits**: Single public videos only (max 1080p default, up to 12 GiB). Livestreams, private/members-only videos, and DRM protected videos are not supported.
- **Compliance**: For public videos the operator is entitled to use. Does not bypass DRM or paywalls.

### Handling YouTube bot-checks on GitHub Actions (YOUTUBE_COOKIES)
GitHub-hosted Actions runners use datacenter IPs that YouTube may challenge with "Sign in to confirm you're not a bot".

To ensure reliable downloads:
1. Export cookies in Netscape format (`cookies.txt`) from a **throwaway Google account** (never your personal main account, to prevent account flagging).
2. Go to your repo: **Settings → Secrets and variables → Actions → New repository secret**.
3. Name: `YOUTUBE_COOKIES`
4. Value: Paste the text of your exported `cookies.txt`.
5. Stage A and Stage B will pass the cookies securely with restrictive permissions (0600) and wipe them immediately after download.

