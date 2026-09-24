# Tampermonkey Scripts

Userscripts for the [Tampermonkey](https://www.tampermonkey.net/) extension. Each script adds a panel on the page, waits a random gap between actions, and stops at a daily limit that resets at local midnight.

More scripts will be added to this list.

## 📦 Scripts

| Script | Site | What it does |
| --- | --- | --- |
| [GitHub Follow](#github-follow) | github.com | Follows people on a followers or following page, then opens the next page |
| [X Follow / Unfollow](#x-follow--unfollow) | x.com and twitter.com | Follows or unfollows accounts, with a shared daily cap |

Defaults for both: **200 actions per day**, and a **random wait of 5-6 minutes** between actions. Leave the tab open in the foreground so the timer stays accurate.

### GitHub Follow

File: [`github-follow.user.js`](github-follow.user.js) · version 1.0.7

Open a GitHub followers or following page, for example `https://github.com/orgs/ccxt/followers`, and press **Start**. The panel sits at the bottom left.

- Follows accounts that still show a **Follow** button
- Skips your own account and anyone you already follow
- When the page is finished, opens **Next** and keeps going
- Remembers that it is running, so it continues after the next page loads
- Daily max from 1 to 5,000 (default 200). The count resets at local midnight
- Random delay between follows, from 0.1 to 180 minutes (default 5-6)
- Shows today's count, how many are left on this page, and how long a full day will take
- Live log, **Stop**, and **Reset today's count**
- Desktop notice when the daily limit is reached or the list is finished
- Stops after three follows that GitHub does not confirm

### X Follow / Unfollow

File: [`x-follow-unfollow.user.js`](x-follow-unfollow.user.js) · version 1.0.0

Stay logged in on X. The panel sits at the top right.

**Follow:** open someone's followers page, or a People search, choose **Follow**, press **Start**.

**Unfollow:** open your own Following page, choose **Unfollow**, press **Start**.

- Follow and unfollow share one daily max (default 200). Separate follow and unfollow counts are shown
- Scrolls the list to load more accounts, then stops when nothing new appears
- Optional: unfollow only people who do not follow you (on by default)
- You can change the "Follows you" label if X is not in English
- Whitelist: handles listed there are never unfollowed
- Confirms the unfollow dialog for you
- Stops if X shows a rate-limit message, or if another dialog is blocking the page
- Skips pending follow requests
- Shows how many accounts are on screen and how many are ready
- Live log, pace estimate, **Stop**, and **Reset today's count**
- Desktop notice when the daily limit is reached, the page runs out of accounts, or actions stop confirming
- Stops after three actions that X does not confirm

## 🔧 Install

1. Install the **Tampermonkey** extension:
   - [Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - [Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/)
   - [Microsoft Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)
   - [Safari and other browsers](https://www.tampermonkey.net/)
2. Open the `.user.js` file you want from this repo.
3. Click **Raw**.
4. Tampermonkey opens an install page. Click **Install**.

The script runs when you visit that site. Open the page described above and press **Start** on the panel.

## ⭐ Star

If a script is useful, a star helps other people find this repo. Thank you.
