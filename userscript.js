// ==UserScript==
// @name          Discord Mass Deleter
// @description   Extends the discord interface so you can mass delete messages and remove your own reactions from discord. Improved all aspects such as timing, backoffs, bugs, etc.
// @namespace     https://github.com/gen3vra/deletediscordmessages
// @version       1.5
// @match         https://discord.com/*
// @grant         none
// @license       ???
// ==/UserScript==

const wait = async ms => new Promise(done => setTimeout(done, ms));
const msToHMS = s => `${s / 3.6e6 | 0}h ${(s % 3.6e6) / 6e4 | 0}m ${(s % 6e4) / 1000 | 0}s`;
const escapeHTML = html => html.replace(/[&<"']/g, m => ({'&': '&amp;', '<': '&lt;', '"': '&quot;', '\'': '&#039;'})[m]);
const redact = str => `<span class="priv">${escapeHTML(str)}</span><span class="mask">REDACTED</span>`;
const ask = async msg => new Promise(resolve => setTimeout(() => resolve(window.confirm(msg)), 10));
const randomBetween = (min, max) => Math.random() * (max - min) + min;
const toSnowflake = (date) => /:/.test(date) ? ((new Date(date).getTime() - 1420070400000) * Math.pow(2, 22)) : date;
const MAX_SCANBACK = 5000;

/**
 * Delete all messages in a Discord channel or DM
 * @param {string} authToken Your authorization token
 * @param {string} authorId Author of the messages you want to delete
 * @param {string} guildId Server were the messages are located
 * @param {string} channelId Channel were the messages are located
 * @param {string} minId Only delete messages after this, leave blank do delete all
 * @param {string} maxId Only delete messages before this, leave blank do delete all
 * @param {string} content Filter messages that contains this text content
 * @param {boolean} hasLink Filter messages that contains link
 * @param {boolean} hasFile Filter messages that contains file
 * @param {boolean} includeNsfw Search in NSFW channels
 * @param {function(string, Array)} extLogger Function for logging
 * @param {function} stopHndl stopHndl used for stopping
 * @see https://github.com/gen3vra/deletediscordmessages
 */
async function deleteMessages(authToken, authorId, guildId, channelId, minId, maxId, content, hasLink, hasFile, includeNsfw, includePinned, extLogger, stopHndl, onProgress) {
    const start = new Date();
    const ArchivedThreads = new Set();
    const ForbiddenChannels = new Set();
    const DELAY_MIN = 1000;
    const DELAY_MAX = 2000;
    const DELAY_DECAY_MIN = 0.91843;
    const DELAY_DECAY_MAX = 0.96433;
    const THROTTLE_MULTIPLIER_MIN = 1.421;
    const THROTTLE_MULTIPLIER_MAX = 1.632;
    const THROTTLE_THRESHOLD_MIN = 1.434;
    const THROTTLE_THRESHOLD_MAX = 1.654;
    const SUCCESSES_BEFORE_SPEEDUP = 5;
    const randomDelay = () => randomBetween(DELAY_MIN, DELAY_MAX);
    const randomDecay = () => randomBetween(DELAY_DECAY_MIN, DELAY_DECAY_MAX);
    const randomThrottleMultiplier = () => randomBetween(THROTTLE_MULTIPLIER_MIN, THROTTLE_MULTIPLIER_MAX);
    const randomThrottleThreshold = () => randomBetween(THROTTLE_THRESHOLD_MIN, THROTTLE_THRESHOLD_MAX);
    let baseDeleteDelay = randomDelay();
    let deleteDelay = baseDeleteDelay;
    let searchDelay = randomDelay();
    let backingOff = false;
    let delCount = 0;
    let goneCount = 0;
    let blockedSkipCount = 0;
    let failCount = 0;
    let avgPing;
    let lastPing;
    let grandTotal;
    let throttledCount = 0;
    let throttledTotalTime = 0;
    let offset = 0;
    let iterations = -1;
    let ended = false;
    let successInRow = 0;

    const queryString = params => params.filter(p => p[1] !== undefined).map(p => p[0] + '=' + encodeURIComponent(p[1])).join('&');
    const printDelayStats = () => log.verb(`Delete delay: ${deleteDelay}ms, Search delay: ${searchDelay}ms`, `Last Ping: ${lastPing}ms, Average Ping: ${avgPing | 0}ms`);
    const resetDelays = () => {
        baseDeleteDelay = randomDelay();
        deleteDelay = baseDeleteDelay;
        searchDelay = randomDelay();
        backingOff = false;
    };
    const blockedChannelReason = (id) => ArchivedThreads.has(id) ? 'archived thread' : ForbiddenChannels.has(id) ? 'no permission' : null;
    const reportProgress = (markUndeletable) => {
        try {if (onProgress) onProgress(delCount + goneCount, grandTotal || 1, markUndeletable);} catch (e) { }
    };

    const log = {
        debug() {extLogger ? extLogger('debug', arguments) : console.debug.apply(console, arguments);},
        info() {extLogger ? extLogger('info', arguments) : console.info.apply(console, arguments);},
        verb() {extLogger ? extLogger('verb', arguments) : console.log.apply(console, arguments);},
        warn() {extLogger ? extLogger('warn', arguments) : console.warn.apply(console, arguments);},
        error() {extLogger ? extLogger('error', arguments) : console.error.apply(console, arguments);},
        success() {extLogger ? extLogger('success', arguments) : console.info.apply(console, arguments);},
    };

    async function recurse() {
        let API_SEARCH_URL;
        if (guildId === '@me') {
            API_SEARCH_URL = `https://discord.com/api/v6/channels/${channelId}/messages/`; // DMs
        }
        else {
            API_SEARCH_URL = `https://discord.com/api/v6/guilds/${guildId}/messages/`; // Server
        }

        const headers = {
            'Authorization': authToken
        };

        let resp;
        try {
            const s = Date.now();
            resp = await fetch(API_SEARCH_URL + 'search?' + queryString([
                ['author_id', authorId || undefined],
                ['channel_id', (guildId !== '@me' ? channelId : undefined) || undefined],
                ['min_id', minId ? toSnowflake(minId) : undefined],
                ['max_id', maxId ? toSnowflake(maxId) : undefined],
                ['sort_by', 'timestamp'],
                ['sort_order', 'desc'],
                ['offset', offset],
                ['has', hasLink ? 'link' : undefined],
                ['has', hasFile ? 'file' : undefined],
                ['content', content || undefined],
                ['include_nsfw', includeNsfw ? true : undefined],
            ]), {headers});
            lastPing = (Date.now() - s);
            avgPing = avgPing > 0 ? (avgPing * 0.9) + (lastPing * 0.1) : lastPing;
        } catch (err) {
            return log.error('Search request threw an error:', err);
        }

        // Not indexed yet
        if (resp.status === 202) {
            const w = (await resp.json()).retry_after;
            throttledCount++;
            throttledTotalTime += w;
            log.warn(`This channel wasn't indexed, waiting ${w}ms for discord to index it...`);
            await wait(w);
            return await recurse();
        }

        if (!resp.ok) {
            // Searching messages too fast
            if (resp.status === 429) {
                const w = (await resp.json()).retry_after;
                throttledCount++;
                throttledTotalTime += w;
                searchDelay = w * 1.1; // set delay
                log.warn(`Discord said don't search for ${w}ms!`);
                printDelayStats();

                //this seems like a bug in the original script
                //await wait(w * 2);
                await wait(searchDelay);
                return await recurse();
            } else {
                return log.error(`Error searching messages, API responded with status ${resp.status}!\n`, await resp.json());
            }
        }

        const data = await resp.json();
        const total = data.total_results;
        if (!grandTotal) grandTotal = total;
        const discoveredMessages = data.messages.map(convo => convo.find(message => message.hit === true));
        // filter out system messages and optionally pinned ones
        let messagesToDelete = discoveredMessages.filter(msg => {
            return (msg.type === 0 || msg.type === 6) && (includePinned || !msg.pinned);
        });
        // skip message if its channel is already known to be undeletable
        messagesToDelete = messagesToDelete.filter(msg => {
            const reason = blockedChannelReason(msg.channel_id);
            if (reason) {
                log.verb(`Skipping message in channel ${msg.channel_id} (${reason})`);
                return false;
            }
            return true;
        });
        const skippedMessages = discoveredMessages.filter(msg => !messagesToDelete.find(m => m.id === msg.id));
        // count skipped messages as not deleted
        failCount += skippedMessages.length;
        const blockedCount = skippedMessages.filter(msg => blockedChannelReason(msg.channel_id)).length;
        const systemCount = skippedMessages.length - blockedCount;
        blockedSkipCount += blockedCount;
        // signal progress UI that undeletable messages were found
        if (skippedMessages.length > 0) {
            reportProgress(true);
        }

        const end = () => {
            if (ended)
                return;
            log.success(`Ended at ${new Date().toLocaleString()}! Total time: ${msToHMS(Date.now() - start.getTime())}`);
            // unnecessary
            // printDelayStats();
            log.verb(`Rate Limited: ${throttledCount} times. Total time throttled: ${msToHMS(throttledTotalTime)}.`);
            log.debug(`Deleted ${delCount} messages, ${failCount} failed${goneCount ? `, ${goneCount} already gone` : ''}.\n`);
            ended = true;
        }

        const isRunComplete = () => (delCount + goneCount + failCount) >= grandTotal;

        const deletableMessages = grandTotal - blockedSkipCount;
        const etr = msToHMS((searchDelay * Math.round(deletableMessages / 25)) + ((deleteDelay + avgPing) * deletableMessages));
        // systemCount already computed above when updating counters
        log.info(`Total messages found: ${data.total_results}`,
            `(Hits: ${data.messages.length}, Delete: ${messagesToDelete.length}, Skipped: ${skippedMessages.length} (system ${systemCount}))`,
            `offset: ${offset}`);
        printDelayStats();
        log.verb(`Estimated time remaining: ${etr}`)

        if (messagesToDelete.length > 0) {

            if (++iterations < 1) {
                log.verb(`Waiting for your confirmation...`);
                const previewMessages = messagesToDelete; // [...messagesToDelete].reverse(); (use if you want the preview to match discords ui)
                if (!await ask(`Do you want to delete ~${total} messages?\nEstimated time: ${etr}\n\n---- Preview ----\n` +
                    previewMessages.map(m => `${m.author.username}#${m.author.discriminator}: ${m.attachments.length ? '[ATTACHMENTS]' : m.content}`).join('\n')))
                    return end(log.error('Aborted by you!'));
                log.verb(`OK`);
            }

            for (let i = 0; i < messagesToDelete.length; i++) {
                const message = messagesToDelete[i];
                // if already marked, skip
                const blockedReason = blockedChannelReason(message.channel_id);
                if (blockedReason) {
                    log.verb(`Skipping message in channel ${message.channel_id} (${blockedReason})`);
                    continue;
                }
                if (stopHndl && stopHndl() === false) return end(log.error('Stopped by you!'));

                // Too big to read, too much information to be useful to end user
                // if you care about individual IDs being deleted or your username, there ya go:
                //log.debug(`${((delCount + 1) / grandTotal * 100).toFixed(2)}% (${delCount + 1}/${grandTotal})` + `Delete ID:${redact(message.id)} <b>${redact(message.author.username + '#' + message.author.discriminator)} <small>(${redact(new Date(message.timestamp).toLocaleString())})</small>:</b> <i>${redact(message.content).replace(/\n/g, '↵')}</i>`, message.attachments.length ? redact(JSON.stringify(message.attachments)) : '');
                const processed = delCount + goneCount + failCount;
                log.debug(`${((processed + 1) / grandTotal * 100).toFixed(2)}% (${processed + 1}/${grandTotal})` + ` | <b>DEL</b> <small>(${redact(new Date(message.timestamp).toLocaleDateString() + " - " + new Date(message.timestamp).toLocaleTimeString())})</small>: ${redact(message.content).replace(/\n/g, '↵')}`, message.attachments.length ? redact(JSON.stringify(message.attachments)) : '');

                let resp;
                try {
                    const s = Date.now();
                    const API_DELETE_URL = `https://discord.com/api/v6/channels/${message.channel_id}/messages/${message.id}`;
                    resp = await fetch(API_DELETE_URL, {
                        headers,
                        method: 'DELETE'
                    });
                    lastPing = (Date.now() - s);
                    avgPing = (avgPing * 0.9) + (lastPing * 0.1);
                } catch (err) {
                    log.error('Delete request throwed an error:', err); // Too long to be read in the console
                    log.verb('Related object:', redact(JSON.stringify(message))); // Too long to be read in the console
                    failCount++;
                    if (i < messagesToDelete.length - 1) {
                        await wait(deleteDelay);
                    }
                    continue;
                }

                if (!resp.ok) {
                    // failed
                    let err;
                    try {err = await resp.json();} catch {err = null;}

                    successInRow = 0;

                    // Thread archived or can't be opened due to missing permissions or rate limits (Program can't discern between the two)
                    if ((resp.status === 400 && err?.code === 50083) ||
                        (resp.status === 403 && err?.message && /archiv/i.test(err.message)) ||
                        (resp.status === 404 && err?.message && /archiv/i.test(err.message))) {
                        log.warn(`Archived thread detected (status ${resp.status}${err?.code ? ', code ' + err.code : ''}), marking channel ${message.channel_id} as archived`);
                        ArchivedThreads.add(message.channel_id);
                        continue;
                    }

                    // message is already gone, nothing to retry
                    else if (resp.status === 404 || err?.code === 10008) {
                        goneCount++;
                        log.verb(`Message ${redact(message.id)} was already deleted.`);
                        reportProgress();
                    }

                    // no permission in this channel, every other message here will fail the same way
                    else if (resp.status === 403 && (err?.code === 50013 || err?.code === 50001)) {
                        ForbiddenChannels.add(message.channel_id);
                        failCount++;
                        log.error(`Missing permissions in channel ${message.channel_id} (code ${err.code}), skipping the rest of it.`);
                    }

                    // system messages can never be deleted
                    else if (err?.code === 50021) {
                        failCount++;
                        log.warn(`Message ${redact(message.id)} is a system message and cannot be deleted.`);
                    }

                    // deleting messages too fast
                    else if (resp.status === 429) {
                        const w = err?.retry_after;
                        log.warn(`Failed to delete - Discord said go away for ${w}ms!`);

                        throttledCount++;
                        throttledTotalTime += w;
                        backingOff = true;

                        if (deleteDelay < w * randomThrottleThreshold()) {
                            deleteDelay = w * randomThrottleMultiplier();
                        }
                        else {
                            // we would get caught in a loop
                            deleteDelay *= randomDecay();
                            if (deleteDelay < w)
                                deleteDelay = w * randomThrottleMultiplier();
                            log.warn("Delete delay is already greater than wait time. Reduce instead.");
                        }

                        printDelayStats();

                        await wait(deleteDelay);
                        i--; // retry
                    }
                    //nonspecific error handler
                    else {
                        log.error(`Error deleting message, API responded with status ${resp.status}!`, err);
                        log.verb('Related object:', redact(JSON.stringify(message)));
                        failCount++;
                    }
                }
                else {
                    // success
                    successInRow++;
                    delCount++;
                    // update progress after a successful delete
                    reportProgress();

                    if (!backingOff) {
                        baseDeleteDelay = randomDelay();
                        deleteDelay = baseDeleteDelay;
                    }
                    else if (successInRow >= SUCCESSES_BEFORE_SPEEDUP && deleteDelay > baseDeleteDelay) {
                        deleteDelay *= randomDecay();
                        log.verb(`Lowering delay to ${deleteDelay}ms`);
                    }
                    else if (deleteDelay <= baseDeleteDelay) {
                        baseDeleteDelay = randomDelay();
                        deleteDelay = baseDeleteDelay;
                        backingOff = false;
                        log.verb(`Default delay, ${baseDeleteDelay}.`);
                    }
                }

                if (i < messagesToDelete.length - 1) {
                    await wait(deleteDelay);
                }
            }

            if (skippedMessages.length > 0) {
                /*grandTotal -= skippedMessages.length;*/
                offset += skippedMessages.length;
                log.verb(`Found ${skippedMessages.length} system messages! Increasing offset to ${offset}.`);
            }

            if (isRunComplete()) {
                return end();
            }

            resetDelays();

            log.verb(`Searching next messages in ${searchDelay}ms...`, (offset ? `(offset: ${offset})` : ''));

            await wait(searchDelay);
            logArea.innerHTML = '';

            if (stopHndl && stopHndl() === false) return end(log.error('Cancelled by you!'));

            return await recurse();
        } else {
            // Nothing on this page could be deleted (either system or blocked)
            if (skippedMessages.length > 0) {
                log.verb(`No deletables on this page (${systemCount} system, ${blockedCount} blocked). Advancing offset by ${skippedMessages.length}.`);
                offset += skippedMessages.length;
                if (isRunComplete()) {
                    return end();
                }
                if (offset >= total) {
                    return end();
                }
                log.verb(`Searching next messages in ${searchDelay}ms...`, `(offset: ${offset})`);
                await wait(searchDelay);
                return await recurse();
            }
            if (total - offset > 0) {
                log.warn('API returned an empty page. Searching next page.');
                offset += 25;
                log.verb(`Searching next messages in ${searchDelay}ms...`, `(offset: ${offset})`);
                await wait(searchDelay);
                await recurse();
                return end();
            } else {
                log.warn("(Total - offset) < 0, ending.");
                return end();
            }
        }
    }

    log.success(`\nStarted at ${start.toLocaleString()}`);
    log.debug(`authorId="${redact(authorId)}" guildId="${redact(guildId)}" channelId="${redact(channelId)}" minId="${redact(minId)}" maxId="${redact(maxId)}" hasLink=${!!hasLink} hasFile=${!!hasFile}`);
    ended = false;
    reportProgress();
    return await recurse();
}

async function deleteReactions(authToken, channelId, startId, scanLimit, ignoreAuthorId, extLogger, stopHndl, onProgress) {
    const start = new Date();
    const API_CHANNEL_URL = `https://discord.com/api/v6/channels/${channelId}`;
    const PAGE_SIZE = 100;
    scanLimit = Math.min(Math.max(1, parseInt(scanLimit, 10) || 1), MAX_SCANBACK);
    const SCAN_DELAY_MIN = 1900;
    const SCAN_DELAY_MAX = 3100;
    const SCAN_PAGES_BEFORE_BREATHER_MIN = 5;
    const SCAN_PAGES_BEFORE_BREATHER_MAX = 8;
    const SCAN_BREATHER_MIN = 4200;
    const SCAN_BREATHER_MAX = 7600;
    const REMOVE_DELAY_MIN = 900;
    const REMOVE_DELAY_MAX = 1500;
    const REMOVE_DECAY_MIN = 0.91843;
    const REMOVE_DECAY_MAX = 0.96433;
    const THROTTLE_MULTIPLIER_MIN = 1.421;
    const THROTTLE_MULTIPLIER_MAX = 1.632;
    const SUCCESSES_BEFORE_SPEEDUP = 5;
    const randomScanDelay = () => randomBetween(SCAN_DELAY_MIN, SCAN_DELAY_MAX);
    const randomScanBreather = () => randomBetween(SCAN_BREATHER_MIN, SCAN_BREATHER_MAX);
    const randomPagesBeforeBreather = () => Math.floor(randomBetween(SCAN_PAGES_BEFORE_BREATHER_MIN, SCAN_PAGES_BEFORE_BREATHER_MAX + 1));
    const randomRemoveDelay = () => randomBetween(REMOVE_DELAY_MIN, REMOVE_DELAY_MAX);
    const randomDecay = () => randomBetween(REMOVE_DECAY_MIN, REMOVE_DECAY_MAX);
    const randomThrottleMultiplier = () => randomBetween(THROTTLE_MULTIPLIER_MIN, THROTTLE_MULTIPLIER_MAX);
    let baseRemoveDelay = randomRemoveDelay();
    let removeDelay = baseRemoveDelay;
    let baseScanDelay = randomScanDelay();
    let scanDelay = baseScanDelay;
    let scanBackingOff = false;
    let scanSuccessInRow = 0;
    let pagesRead = 0;
    let pagesUntilBreather = randomPagesBeforeBreather();
    let backingOff = false;
    let successInRow = 0;
    let scannedCount = 0;
    let removedCount = 0;
    let goneCount = 0;
    let failCount = 0;
    let throttledCount = 0;
    let throttledTotalTime = 0;
    let lastPing;
    let avgPing;

    const headers = {'Authorization': authToken};
    const retryMs = retryAfter => typeof retryAfter === 'number' ? (retryAfter < 1000 ? retryAfter * 1000 : retryAfter) : 1000; // honestly just in case they swap to seconds instead of milliseconds like we upgrade to newer api

    // a deleted custom emoji comes back without a name, the API takes any placeholder there
    const emojiParam = emoji => encodeURIComponent(emoji.id ? `${emoji.name || '_'}:${emoji.id}` : emoji.name);
    const emojiLabel = emoji => emoji.id ? `:${emoji.name || 'unknown'}:` : emoji.name;
    const reportProgress = (value, max, phase, failed) => {
        try {if (onProgress) onProgress(value, max, phase, failed);} catch (e) { }
    };
    const stopRequested = () => stopHndl && stopHndl() === false;

    const log = {
        debug() {extLogger ? extLogger('debug', arguments) : console.debug.apply(console, arguments);},
        info() {extLogger ? extLogger('info', arguments) : console.info.apply(console, arguments);},
        verb() {extLogger ? extLogger('verb', arguments) : console.log.apply(console, arguments);},
        warn() {extLogger ? extLogger('warn', arguments) : console.warn.apply(console, arguments);},
        error() {extLogger ? extLogger('error', arguments) : console.error.apply(console, arguments);},
        success() {extLogger ? extLogger('success', arguments) : console.info.apply(console, arguments);},
    };

    const end = () => {
        log.success(`Ended at ${new Date().toLocaleString()}! Total time: ${msToHMS(Date.now() - start.getTime())}`);
        log.verb(`Rate Limited: ${throttledCount} times. Total time throttled: ${msToHMS(throttledTotalTime)}.`);
        log.debug(`Scanned ${scannedCount} messages, removed ${removedCount} reactions, ${failCount} failed${goneCount ? `, ${goneCount} already gone` : ''}.\n`);
    };

    // snowflakes exceed Number precision dates are converted with BigInt
    const toExactSnowflake = value => {
        if (/^\d+$/.test(value)) return value;
        const ms = new Date(value).getTime();
        return Number.isNaN(ms) ? null : (BigInt(ms - 1420070400000) << 22n).toString();
    };

    // the before cursor is exclusive, so nudge it up to keep the given message in the window
    let before;
    let startBoundary;
    const looksLikeId = /^\d+$/.test(startId || '');
    if (startId) {
        const snowflake = toExactSnowflake(startId);
        if (!snowflake) {
            log.error(`"${escapeHTML(startId)}" is not a message ID or a date. Fix it or clear it to start at the newest message.`);
            return;
        }
        startBoundary = BigInt(snowflake);
        before = (startBoundary + 1n).toString();
    }

    log.success(`\nStarted at ${start.toLocaleString()}`);
    log.debug(`channelId="${redact(channelId)}" startId="${redact(startId || 'newest')}" scanLimit=${scanLimit}${ignoreAuthorId ? ` ignoreAuthorId="${redact(ignoreAuthorId)}"` : ''}`);
    log.info(`Scanning up to ${scanLimit} messages for reactions you left, starting at ${before ? 'the message you gave (it is included) ' : 'the newest message'} and walking back to older messages only.`);
    log.info(ignoreAuthorId ? 'Messages you wrote are being skipped.' : 'Every message is being read, including the ones you wrote.');
    reportProgress(0, scanLimit, 'scan');

    const targets = [];
    let reachedStartOfChannel = false;
    let sawStartMessage = false;
    let newestScannedId;

    while (scannedCount < scanLimit) {
        if (stopRequested()) {
            log.error('Stopped by you!');
            reportProgress(scannedCount, scannedCount || 1, 'scan', true);
            return end();
        }

        const pageSize = Math.min(PAGE_SIZE, scanLimit - scannedCount);
        const url = `${API_CHANNEL_URL}/messages?limit=${pageSize}${before ? `&before=${before}` : ''}`;
        let resp;
        try {
            const s = Date.now();
            resp = await fetch(url, {headers});
            log.verb(`GET ${redact(url)} responded ${resp.status}`);
            lastPing = (Date.now() - s);
            avgPing = avgPing > 0 ? (avgPing * 0.9) + (lastPing * 0.1) : lastPing;
        } catch (err) {
            log.error('History request threw an error:', err);
            reportProgress(scannedCount, scanLimit, 'scan', true);
            return end();
        }

        if (resp.status === 429) {
            const w = retryMs((await resp.json().catch(() => ({}))).retry_after);
            throttledCount++;
            throttledTotalTime += w;
            scanBackingOff = true;
            scanSuccessInRow = 0;
            scanDelay = Math.max(scanDelay * randomThrottleMultiplier(), w * randomThrottleMultiplier());
            log.warn(`Discord said don't read history for ${w}ms! Reading pages every ${scanDelay | 0}ms now.`);
            await wait(scanDelay);
            continue;
        }

        if (!resp.ok) {
            const err = await resp.json().catch(() => null);
            if (resp.status === 401) log.error('Your token was rejected. Get it again and retry.', err);
            else if (resp.status === 403) log.error(`No permission to read channel ${redact(channelId)}.`);
            else if (resp.status === 404) log.error(`Channel ${redact(channelId)} does not exist.`);
            else log.error(`Error reading history, API responded with status ${resp.status}!`, err);
            reportProgress(scannedCount, scanLimit, 'scan', true);
            return end();
        }

        const batch = await resp.json();
        if (!Array.isArray(batch)) {
            log.error(`Expected a list of messages, got this instead:`, JSON.stringify(batch));
            reportProgress(scannedCount, scanLimit, 'scan', true);
            return end();
        }
        // a short page still has older messages behind it, only an empty one is the end
        if (batch.length === 0) {
            log.verb(`Discord returned an empty page${before ? ` before ${redact(before)}` : ''}, nothing older to read.`);
            reachedStartOfChannel = true;
            break;
        }

        pagesRead++;

        // the page is not guaranteed to be sorted, so the cursor is the oldest id in it
        let oldestId = BigInt(batch[0].id);
        let skippedNewer = 0;
        let foundHere = 0;
        for (const message of batch) {
            const id = BigInt(message.id);
            if (id < oldestId) oldestId = id;
            if (startBoundary !== undefined && id > startBoundary) {
                skippedNewer++;
                continue;
            }
            if (startBoundary !== undefined && id === startBoundary) sawStartMessage = true;
            if (newestScannedId === undefined || id > newestScannedId) newestScannedId = id;
            scannedCount++;
            if (ignoreAuthorId && message.author && message.author.id === ignoreAuthorId) continue;
            for (const reaction of message.reactions || []) {
                if (!reaction.me && !reaction.me_burst) continue;
                targets.push({messageId: message.id, emoji: reaction.emoji, timestamp: message.timestamp});
                foundHere++;
            }
        }
        before = oldestId.toString();
        if (skippedNewer) log.verb(`Ignored ${skippedNewer} messages newer than the ID you gave.`);

        log.verb(`Scanned ${scannedCount}/${scanLimit} messages, ${targets.length} of your reactions found${foundHere ? ` (${foundHere} on this page)` : ''}.`);
        reportProgress(scannedCount, scanLimit, 'scan');

        if (scannedCount >= scanLimit) break;

        if (!scanBackingOff) {
            baseScanDelay = randomScanDelay();
            scanDelay = baseScanDelay;
        }
        else {
            scanSuccessInRow++;
            if (scanSuccessInRow >= SUCCESSES_BEFORE_SPEEDUP && scanDelay > baseScanDelay) {
                scanDelay *= randomDecay();
                log.verb(`Lowering page delay to ${scanDelay | 0}ms`);
            }
            else if (scanDelay <= baseScanDelay) {
                baseScanDelay = randomScanDelay();
                scanDelay = baseScanDelay;
                scanBackingOff = false;
                log.verb(`Default page delay, ${baseScanDelay | 0}.`);
            }
        }

        await wait(scanDelay);
        if (--pagesUntilBreather <= 0) {
            const breather = randomScanBreather();
            log.verb(`Resting ${breather | 0}ms after ${pagesRead} pages.`);
            await wait(breather);
            pagesUntilBreather = randomPagesBeforeBreather();
        }
    }

    if (reachedStartOfChannel) log.verb(`Reached the start of the channel after ${scannedCount} messages.`);
    if (looksLikeId && !sawStartMessage) log.warn(`Message ${redact(startId)} was not in the history, so the scan began at the newest message older than it. Check the ID is from this channel.`);
    if (newestScannedId !== undefined) log.verb(`Newest message read was ${redact(newestScannedId.toString())}, oldest was ${redact(before || 'unknown')}.`);
    reportProgress(scannedCount, scannedCount || 1, 'scan');

    if (targets.length === 0) {
        log.info(`No reactions of yours in the last ${scannedCount} messages. Nothing to remove.`);
        reportProgress(1, 1, 'remove');
        return end();
    }

    const etr = msToHMS((removeDelay + (avgPing || 0)) * targets.length);
    const preview = targets.slice(0, 25).map(t => `${emojiLabel(t.emoji)}  ${new Date(t.timestamp).toLocaleString()}`).join('\n');
    log.verb(`Waiting for your confirmation...`);
    if (!await ask(`Remove ${targets.length} of your reactions from ${scannedCount} scanned messages?\nEstimated time: ${etr}\n\n---- Preview ----\n${preview}${targets.length > 25 ? `\n...and ${targets.length - 25} more` : ''}`)) {
        log.error('Aborted by you!');
        reportProgress(0, targets.length, 'remove', true);
        return end();
    }
    log.verb(`OK`);
    reportProgress(0, targets.length, 'remove');

    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        if (stopRequested()) {
            log.error('Stopped by you!');
            break;
        }

        const processed = removedCount + goneCount + failCount;
        log.debug(`${((processed + 1) / targets.length * 100).toFixed(2)}% (${processed + 1}/${targets.length})` + ` | <b>RXN</b> <small>(${redact(new Date(target.timestamp).toLocaleDateString() + " - " + new Date(target.timestamp).toLocaleTimeString())})</small>: ${redact(emojiLabel(target.emoji))}`);

        let resp;
        try {
            const s = Date.now();
            resp = await fetch(`${API_CHANNEL_URL}/messages/${target.messageId}/reactions/${emojiParam(target.emoji)}/@me`, {headers, method: 'DELETE'});
            lastPing = (Date.now() - s);
            avgPing = (avgPing * 0.9) + (lastPing * 0.1);
        } catch (err) {
            log.error('Reaction removal threw an error:', err);
            failCount++;
            reportProgress(removedCount + goneCount + failCount, targets.length, 'remove', true);
            if (i < targets.length - 1) await wait(removeDelay);
            continue;
        }

        if (!resp.ok) {
            let err;
            try {err = await resp.json();} catch {err = null;}
            successInRow = 0;

            // message or reaction is already gone, nothing to retry
            if (resp.status === 404 || err?.code === 10008 || err?.code === 10014) {
                goneCount++;
                if (err?.code === 10014) log.warn(`Discord did not recognise the emoji ${redact(emojiLabel(target.emoji))} on message ${redact(target.messageId)} (sent as "${redact(decodeURIComponent(emojiParam(target.emoji)))}"), so that reaction was left alone.`);
                else log.verb(`Reaction on message ${redact(target.messageId)} was already gone.`);
                reportProgress(removedCount + goneCount + failCount, targets.length, 'remove');
            }

            else if (resp.status === 403) {
                failCount++;
                log.error(`No permission to remove reactions in channel ${redact(channelId)} (code ${err?.code}), stopping.`);
                reportProgress(removedCount + goneCount + failCount, targets.length, 'remove', true);
                break;
            }

            else if (resp.status === 429) {
                const w = retryMs(err?.retry_after);
                log.warn(`Failed to remove - Discord said go away for ${w}ms!`);
                throttledCount++;
                throttledTotalTime += w;
                backingOff = true;
                removeDelay = Math.max(removeDelay * randomDecay(), w * randomThrottleMultiplier());
                log.verb(`Remove delay: ${removeDelay | 0}ms, Last Ping: ${lastPing}ms, Average Ping: ${avgPing | 0}ms`);
                await wait(removeDelay);
                i--; // retry
                continue;
            }

            else {
                log.error(`Error removing reaction, API responded with status ${resp.status}!`, err);
                failCount++;
                reportProgress(removedCount + goneCount + failCount, targets.length, 'remove', true);
            }
        }
        else {
            successInRow++;
            removedCount++;
            reportProgress(removedCount + goneCount + failCount, targets.length, 'remove');

            if (!backingOff) {
                baseRemoveDelay = randomRemoveDelay();
                removeDelay = baseRemoveDelay;
            }
            else if (successInRow >= SUCCESSES_BEFORE_SPEEDUP && removeDelay > baseRemoveDelay) {
                removeDelay *= randomDecay();
                log.verb(`Lowering delay to ${removeDelay | 0}ms`);
            }
            else if (removeDelay <= baseRemoveDelay) {
                baseRemoveDelay = randomRemoveDelay();
                removeDelay = baseRemoveDelay;
                backingOff = false;
                log.verb(`Default delay, ${baseRemoveDelay | 0}.`);
            }
        }

        if (i < targets.length - 1) await wait(removeDelay);
    }

    log.info(`Removed ${removedCount} reactions from ${scannedCount} scanned messages.`);
    return end();
}

//---- User interface ----//

let popover;
let btn;
let stop;
let rxStopped;
let logArea;
let version = "1.5";

function initUI() {

    const insertCss = (css) => {
        const style = document.createElement('style');
        style.appendChild(document.createTextNode(css));
        document.head.appendChild(style);
        return style;
    }

    const createElm = (html) => {
        const temp = document.createElement('div');
        temp.innerHTML = html;
        return temp.removeChild(temp.firstElementChild);
    }

    insertCss(`
        #undicord-btn{position: relative; height: 24px;width: auto;-webkit-box-flex: 0;-ms-flex: 0 0 auto;flex: 0 0 auto;margin: 0 8px;cursor:pointer; color: var(--interactive-normal);}
        #undiscord{--gen-accent:#5865f2;position:fixed;top:100px;right:10px;bottom:10px;width:840px;max-width:calc(100vw - 20px);z-index:99;color:lightgrey;background-color:black;box-shadow:var(--elevation-stroke),var(--elevation-high);border-radius:4px;display:flex;flex-direction:column;font-size:15px;line-height:1.4}
        #undiscord a{color:#00b0f4}
        #undiscord a:hover{text-decoration:underline}
        #undiscord.redact .priv{display:none!important}
        #undiscord:not(.redact) .mask{display:none!important}
        #undiscord.redact [priv]{-webkit-text-security:disc!important}
        #undiscord .toolbar span{margin-right:8px}
        #undiscord button,#undiscord .btn{color:#fff;background:#7289da;border:0;border-radius:4px;font-size:15px;padding:7px 16px;line-height:1.2;cursor:pointer;transition:filter .12s ease}
        #undiscord button:hover:not(:disabled),#undiscord .btn:hover{filter:brightness(1.1)}
        #undiscord button:active:not(:disabled),#undiscord .btn:active{filter:brightness(.92)}
        #undiscord button:focus-visible,#undiscord .btn:focus-visible{outline:2px solid var(--gen-accent);outline-offset:1px}
        #undiscord button:disabled{display:none}
        #undiscord input[type="text"],#undiscord input[type="search"],#undiscord input[type="password"],#undiscord input[type="datetime-local"],#undiscord input[type="number"]{background-color:#202225;color:#dcddde;border-radius:4px;border:1px solid transparent;padding:0 .65em;height:32px;width:168px;margin:3px 6px 3px 0;font-size:15px;transition:border-color .12s ease}
        #undiscord input[type="text"]:hover,#undiscord input[type="search"]:hover,#undiscord input[type="password"]:hover,#undiscord input[type="datetime-local"]:hover,#undiscord input[type="number"]:hover{border-color:rgba(255,255,255,.15)}
        #undiscord input:focus-visible{outline:2px solid var(--gen-accent);outline-offset:1px}
        #undiscord input#file{display:none}
        #undiscord input[type="checkbox"]{width:15px;height:15px;vertical-align:middle;margin:0;accent-color:var(--gen-accent);cursor:pointer}
        #undiscord label{display:inline-flex;align-items:center;gap:4px;cursor:pointer;margin:3px 0}
        #undiscord hr{border-color:rgba(255,255,255,0.1);margin:14px 0}
        #undiscord .header{padding:14px 18px 0;background-color:var(--background-tertiary);color:var(--text-muted)}
        #undiscord .titlebar{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
        #undiscord .brand{font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
        #undiscord .ver{font-size:11px;letter-spacing:.16em;color:#5c5f66}
        #undiscord .tabs{display:flex;gap:4px;margin-top:10px}
        #undiscord .tab{background:transparent;color:#8a8d93;font-size:12px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;padding:9px 16px;border-radius:4px 4px 0 0;border-bottom:3px solid transparent;cursor:pointer;transition:color .12s ease,background-color .12s ease,border-color .12s ease}
        #undiscord .tab:hover{color:#dcdde1;background:rgba(255,255,255,.03)}
        #undiscord .tab[aria-selected="true"]{color:#fff;font-weight:600;background:rgba(255,255,255,.04);border-bottom-color:var(--gen-accent)}
        #undiscord .tab:focus-visible{outline:2px solid var(--gen-accent);outline-offset:-4px}
        #undiscord .lbl{display:inline-block;font-size:11.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#9a9da3;margin-bottom:6px}
        #undiscord .fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px 20px;align-items:start}
        #undiscord .hint{display:inline-block;font-size:13px;color:#9a9da3;margin-left:4px}
        #undiscord .note{display:block;font-size:13.5px;color:#b1b4b9;line-height:1.55;margin:10px 2px 0}
        #undiscord .accent{background:var(--gen-accent)}
        #undiscord .secondary{background:#4f545c}
        #undiscord .ghost{background:transparent;color:#b9bbbe;border:1px solid rgba(255,255,255,.18);border-radius:4px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;padding:3px 10px;cursor:pointer;transition:color .12s ease,border-color .12s ease}
        #undiscord .ghost:hover{color:#fff;border-color:var(--gen-accent)}
        #undiscord .ghost:focus-visible{outline:2px solid var(--gen-accent);outline-offset:1px}
        #undiscord progress{vertical-align:middle;accent-color:var(--gen-accent);width:170px;height:10px}
        #undiscord .actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin-top:10px}
        #undiscord .percent,#undiscord .rxPercent{font-weight:600;min-width:2.6em;display:inline-block}
        #undiscord .form{padding:14px 16px;background:var(--background-secondary);box-shadow:0 1px 0 rgba(0,0,0,.2),0 1.5px 0 rgba(0,0,0,.05),0 2px 0 rgba(0,0,0,.05)}
        #undiscord .logarea{overflow:auto;font-size:13.5px;line-height:1.6;font-family:Consolas,Liberation Mono,Menlo,Courier,monospace;flex-grow:1;padding:14px 16px}
        #undiscord progress.complete { accent-color: #43b581; }
        #undiscord progress.incomplete { accent-color: #f04747; }
        #undiscord progress.pending { accent-color: #5865f2; }
        #undicord-btn progress.complete { accent-color: #43b581; }
        #undicord-btn progress.incomplete { accent-color: #f04747; }
        #undicord-btn progress.pending { accent-color: #5865f2; }
        .logarea { scrollbar-width: none;}
        `);

    popover = createElm(`
    <div id="undiscord" style="display:none;">
        <div class="header">
            <div class="titlebar">
                <span class="brand">🌹 Discord Mass Deleter</span>
                <span class="ver">v${version}</span>
            </div>
            <div class="tabs" role="tablist">
                <button class="tab" id="tabMessages" role="tab" aria-selected="true" aria-controls="view-messages">Messages</button>
                <button class="tab" id="tabReactions" role="tab" aria-selected="false" aria-controls="view-reactions">Reactions</button>
            </div>
        </div>
        <div class="form" id="view-messages" role="tabpanel" aria-labelledby="tabMessages">
            <div class="fields">
                <span><b class="lbl">Authorization</b> <button id="getToken" class="ghost">get</button><br>
                    <input type="password" id="authToken" placeholder="Auth Token" autocomplete="off" autofocus><br>
                    <span><b class="lbl">Author</b> <button id="getAuthor" class="ghost">get</button></span>
                    <br><input id="authorId" type="text" placeholder="Author ID" priv></span>
                <span><b class="lbl">Guild/Channel</b>
                    <button id="getGuildAndChannel" class="ghost">get</button><br>
                    <input id="guildId" type="text" placeholder="Guild ID" priv><br>
                    <input id="channelId" type="text" placeholder="Channel ID" priv><br>
                    <label><input id="includeNsfw" type="checkbox">NSFW Channel</label><br><br>
                    <label for="file" title="Import list of channels from messages/index.json file"> Import: <span
                            class="btn">...</span> <input id="file" type="file" accept="application/json,.json"></label>
                </span>
                <span><b class="lbl">Range</b><br>
                    <input id="minDate" type="datetime-local" title="After" style="width:auto;"><br>
                    <input id="maxDate" type="datetime-local" title="Before" style="width:auto;"><br>
                    <input id="minId" type="text" placeholder="After message with Id" priv><br>
                    <input id="maxId" type="text" placeholder="Before message with Id" priv><br>
                </span>
                <span><b class="lbl">Search messages</b><br>
                    <input id="content" type="text" placeholder="Containing text" priv><br>
                    <label><input id="hasLink" type="checkbox">has: link</label><br>
                    <label><input id="hasFile" type="checkbox">has: file</label><br>
                    <label><input id="includePinned" type="checkbox">Include pinned</label>
                </span>
            </div>
            <hr>
            <div class="actions">
                <button id="start" style="background:#43b581;">Start</button>
                <button id="stop" style="background:#f04747;" disabled>Stop</button>
                <button id="clear" class="secondary">Clear log</button>
                <label><input id="autoScroll" type="checkbox" checked>Auto scroll</label>
                <label title="Hide sensitive information for taking screenshots"><input id="redact" type="checkbox">Privacy mode</label>
                <progress id="progress" style="display:none;"></progress> <span class="percent"></span>
            </div>
        </div>
        <div class="form" id="view-reactions" role="tabpanel" aria-labelledby="tabReactions" style="display:none;">
            <div class="fields">
                <span><b class="lbl">Channel</b> <button id="rxGetChannel" class="ghost">get</button><br>
                    <input id="rxChannelId" type="text" placeholder="Channel ID" priv><br>
                    <span class="hint">One channel per run.</span>
                </span>
                <span><b class="lbl">Scan window</b><br>
                    <input id="rxStartId" type="text" placeholder="Message Id or date" priv title="Scanning starts at this message, includes it, and only walks older. Leave blank to start at the newest message."><br>
                    <input id="rxScanLimit" type="number" min="1" max="5000" step="100" value="1000" style="width:auto;" title="How many messages to walk back (max 5000)"> <span class="hint">messages back, max 5000</span>
                </span>
                <span><b class="lbl">Filter</b><br>
                    <label title="Your reactions on your own messages disappear when those messages are deleted"><input id="rxSkipOwn" type="checkbox">Skip messages you wrote</label>
                </span>
            </div>
            <hr>
            <div class="actions">
                <button id="rxStart" style="background:#43b581;">Scan and remove</button>
                <button id="rxStop" style="background:#f04747;" disabled>Stop</button>
                <button id="rxClear" class="secondary">Clear log</button>
                <progress id="rxProgress" style="display:none;"></progress> <span class="rxPercent"></span> <span class="rxPhase hint"></span>
            </div>
        </div>
        <pre class="logarea">
            <center>Improved and updated by Gen 🌹 | ${version}
            </center>
        </pre>
    </div>
    `);

    document.body.appendChild(popover);

    btn = createElm(`<div id="undicord-btn" tabindex="0" role="button" aria-label="Delete Messages" title="Delete Messages">
    <svg aria-hidden="false" width="24" height="24" viewBox="0 0 24 24">
        <path fill="currentColor" d="M15 3.999V2H9V3.999H3V5.999H21V3.999H15Z"></path>
        <path fill="currentColor" d="M5 6.99902V18.999C5 20.101 5.897 20.999 7 20.999H17C18.103 20.999 19 20.101 19 18.999V6.99902H5ZM11 17H9V11H11V17ZM15 17H13V11H15V17Z"></path>
    </svg>
    <br><progress style="display:none; width:24px;"></progress>
</div>`);

    btn.onclick = function togglePopover() {
        if (popover.style.display !== 'none') {
            popover.style.display = 'none';
            btn.style.color = 'var(--interactive-normal)';
        }
        else {
            popover.style.display = '';
            btn.style.color = '#f04747';

            // user experience over extra unneeded security
            // let's grab all needed details when opening
            const m = location.href.match(/channels\/([\w@]+)\/(\d+)/);
            $('input#guildId').value = m[1];
            $('input#channelId').value = m[2];
            $('input#rxChannelId').value = m[2];

            window.dispatchEvent(new Event('beforeunload'));
            const ls = document.body.appendChild(document.createElement('iframe')).contentWindow.localStorage;
            const iframe = document.createElement('iframe');
            const token = JSON.parse(document.body.appendChild(iframe).contentWindow.localStorage.token)
            iframe.remove();
            $('input#authToken').value = token;

            webpackChunkdiscord_app.push([
                [Math.random()],
                {},
                (r) => {
                    for (const m of Object.keys(r.c)) {
                        try {
                            const mod = r.c[m].exports;
                            if (mod?.default?.getUsers || mod?.getUsers) {
                                const users = (mod.default || mod).getUsers();
                                const user = Object.values(users).find(u => u.email);
                                if (user) {
                                    $('input#authorId').value = user.id;
                                    return;
                                }
                            }
                        } catch { }
                    }
                }
            ]);

        };
    }

    const readToken = () => {
        let token;
        const iframe = document.createElement('iframe');
        token = JSON.parse(document.body.appendChild(iframe).contentWindow.localStorage.token)
        iframe.remove();
        return token;
    };

    const readCurrentUserId = () => {
        let userId;
        webpackChunkdiscord_app.push([
            [Math.random()],
            {},
            (r) => {
                for (const m of Object.keys(r.c)) {
                    try {
                        const mod = r.c[m].exports;
                        if (mod?.default?.getUsers || mod?.getUsers) {
                            const users = (mod.default || mod).getUsers();
                            const user = Object.values(users).find(u => u.email);
                            if (user) {
                                userId = user.id;
                                return;
                            }
                        }
                    } catch { }
                }
            }
        ]);
        return userId;
    };

    function mountBtn() {
        const toolbar = document.querySelector('[class*="toolbar"]');
        if (toolbar)
            toolbar.appendChild(btn);
    }

    const observer = new MutationObserver(function (_mutationsList, _observer) {
        if (!document.body.contains(btn)) mountBtn(); // re-mount the button to the toolbar
    });
    observer.observe(document.body, {attributes: false, childList: true, subtree: true});

    mountBtn();

    const $ = s => popover.querySelector(s);
    logArea = $('pre');
    const startBtn = $('button#start');
    const stopBtn = $('button#stop');
    const autoScroll = $('#autoScroll');

    const fileSelection = $("input#file");
    fileSelection.addEventListener("change", () => {
        const files = fileSelection.files;
        const channelIdField = $('input#channelId');
        if (files.length > 0) {
            const file = files[0];
            file.text().then(text => {
                let json = JSON.parse(text);
                let channels = Object.keys(json);
                channelIdField.value = channels.join(",");
            });
        }
    }, false);

    startBtn.onclick = async e => {
        const authToken = $('input#authToken').value.trim();
        const authorId = $('input#authorId').value.trim();
        const guildId = $('input#guildId').value.trim();
        const channelIds = $('input#channelId').value.trim().split(/\s*,\s*/);
        const minId = $('input#minId').value.trim();
        const maxId = $('input#maxId').value.trim();
        const minDate = $('input#minDate').value.trim();
        const maxDate = $('input#maxDate').value.trim();
        const content = $('input#content').value.trim();
        const hasLink = $('input#hasLink').checked;
        const hasFile = $('input#hasFile').checked;
        const includeNsfw = $('input#includeNsfw').checked;
        const includePinned = $('input#includePinned').checked;
        const progress = $('#progress');
        const progress2 = btn.querySelector('progress');
        const percent = $('.percent');

        const stopHndl = () => !(stop === true);

        let hasUndeletable = false;
        const onProg = (value, max, markUndeletable = false) => {
            if (markUndeletable) hasUndeletable = true;
            if (value && max && value > max) max = value;
            progress.setAttribute('max', max);
            progress.value = value;
            // always keep the progress visible so the final red/green state can be seen
            progress.style.display = '';
            progress2.setAttribute('max', max);
            progress2.value = value;
            progress2.style.display = '';
            // show percentage even when value is 0 (0 is falsy), but only when both numbers are provided
            if (typeof value === 'number' && typeof max === 'number' && max > 0) {
                percent.innerHTML = Math.round(value / max * 100) + '%';
            }

            // blue by default, red if any undeletable was seen, green only when fully complete with no undeletables
            if (hasUndeletable) {
                progress.style.accentColor = '#f04747';  // red
                progress2.style.accentColor = '#f04747';
            } else if (max && value >= max) {
                // all deleted - show green
                progress.style.accentColor = '#43b581';  // green
                progress2.style.accentColor = '#43b581';
            } else if (max) {
                // pending/in-progress with no undeletables
                progress.style.accentColor = '#5865f2';  // blue
                progress2.style.accentColor = '#5865f2';
            } else {
                // reset to default
                progress.style.accentColor = '';
                progress2.style.accentColor = '';
            }
        };


        stop = stopBtn.disabled = !(startBtn.disabled = true);
        rxStartBtn.disabled = true;
        // pre-reset progress bar so it starts blue immediately
        progress.setAttribute('max', 1);
        progress.value = 0;
        progress.style.accentColor = '#5865f2';
        progress2.setAttribute('max', 1);
        progress2.value = 0;
        progress2.style.accentColor = '#5865f2';
        percent.innerHTML = '0%';
        for (let i = 0; i < channelIds.length; i++) {
            await deleteMessages(authToken, authorId, guildId, channelIds[i], minId || minDate, maxId || maxDate, content, hasLink, hasFile, includeNsfw, includePinned, logger, stopHndl, onProg);
            if (stop === true) break;
        }
        stop = stopBtn.disabled = !(startBtn.disabled = false);
        rxStartBtn.disabled = false;
    };
    stopBtn.onclick = e => stop = stopBtn.disabled = !(startBtn.disabled = false);
    $('button#clear').onclick = e => {
        logArea.innerHTML = '';

        const progress = $('#progress');
        const progress2 = btn.querySelector('progress');
        const percent = $('.percent');

        progress.style.display = 'none';
        progress2.style.display = 'none';
        progress.removeAttribute('max');
        progress2.removeAttribute('max');
        progress.value = 0;
        progress2.value = 0;
        progress.style.accentColor = '';
        progress2.style.accentColor = '';
        percent.textContent = '';
    };
    $('button#getToken').onclick = e => {
        $('input#authToken').value = readToken();
    };
    $('button#getAuthor').onclick = e => {
        $('input#authorId').value = readCurrentUserId();
    };
    $('button#getGuildAndChannel').onclick = e => {
        const m = location.href.match(/channels\/([\w@]+)\/(\d+)/);
        $('input#guildId').value = m[1];
        $('input#channelId').value = m[2];
    };
    const views = {
        messages: {tab: $('#tabMessages'), panel: $('#view-messages'), accent: '#5865f2'},
        reactions: {tab: $('#tabReactions'), panel: $('#view-reactions'), accent: '#5865f2'},
    };
    const showView = name => {
        for (const key of Object.keys(views)) {
            const active = key === name;
            views[key].panel.style.display = active ? '' : 'none';
            views[key].tab.setAttribute('aria-selected', String(active));
            if (active) popover.style.setProperty('--gen-accent', views[key].accent);
        }
        if (name === 'reactions' && !$('input#rxChannelId').value) {
            $('input#rxChannelId').value = $('input#channelId').value;
        }
    };
    views.messages.tab.onclick = e => showView('messages');
    views.reactions.tab.onclick = e => showView('reactions');
    showView('messages');

    const rxStartBtn = $('button#rxStart');
    const rxStopBtn = $('button#rxStop');
    const rxProgress = $('#rxProgress');
    const rxPercent = $('.rxPercent');
    const rxPhase = $('.rxPhase');

    $('button#rxGetChannel').onclick = e => {
        const m = location.href.match(/channels\/([\w@]+)\/(\d+)/);
        $('input#rxChannelId').value = m[2];
    };
    $('button#rxClear').onclick = e => {
        logArea.innerHTML = '';
        const progress2 = btn.querySelector('progress');
        rxProgress.style.display = 'none';
        progress2.style.display = 'none';
        rxProgress.removeAttribute('max');
        progress2.removeAttribute('max');
        rxProgress.value = 0;
        progress2.value = 0;
        rxProgress.style.accentColor = '';
        progress2.style.accentColor = '';
        rxPercent.textContent = '';
        rxPhase.textContent = '';
    };

    rxStopBtn.onclick = e => rxStopped = rxStopBtn.disabled = !(rxStartBtn.disabled = false);
    rxStartBtn.onclick = async e => {
        const authToken = $('input#authToken').value.trim();
        const channelId = $('input#rxChannelId').value.trim() || $('input#channelId').value.trim();
        const startId = $('input#rxStartId').value.trim();
        const progress2 = btn.querySelector('progress');

        let scanLimit = parseInt($('input#rxScanLimit').value, 10);
        if (!Number.isFinite(scanLimit) || scanLimit < 1) scanLimit = 1;
        if (scanLimit > MAX_SCANBACK) scanLimit = MAX_SCANBACK;
        $('input#rxScanLimit').value = scanLimit;

        if (!authToken) return logger('error', ['No auth token. Open the Messages tab and press get, then come back.']);
        if (!channelId) return logger('error', ['Enter a channel ID, or press get to use the channel you have open.']);
        if (channelId.includes(',')) return logger('error', ['Reactions are removed one channel at a time. Leave a single channel ID.']);

        let ignoreAuthorId = '';
        if ($('#rxSkipOwn').checked) {
            ignoreAuthorId = readCurrentUserId() || $('input#authorId').value.trim();
            if (!ignoreAuthorId) return logger('error', ['Could not read your user ID. Uncheck "Skip messages you wrote" to scan every message.']);
        }

        let sawFailure = false;
        const onRxProgress = (value, max, phase, failed) => {
            if (failed) sawFailure = true;
            if (value && max && value > max) max = value;
            rxProgress.setAttribute('max', max);
            rxProgress.value = value;
            rxProgress.style.display = '';
            progress2.setAttribute('max', max);
            progress2.value = value;
            progress2.style.display = '';
            if (typeof value === 'number' && typeof max === 'number' && max > 0) {
                rxPercent.innerHTML = Math.round(value / max * 100) + '%';
            }
            rxPhase.textContent = phase === 'scan' ? 'Reading history' : 'Removing reactions';

            const accent = sawFailure ? '#f04747' : (max && value >= max ? '#43b581' : views.reactions.accent);
            rxProgress.style.accentColor = accent;
            progress2.style.accentColor = accent;
        };

        rxStopped = rxStopBtn.disabled = !(rxStartBtn.disabled = true);
        startBtn.disabled = true;
        rxProgress.setAttribute('max', 1);
        rxProgress.value = 0;
        rxProgress.style.accentColor = views.reactions.accent;
        progress2.setAttribute('max', 1);
        progress2.value = 0;
        progress2.style.accentColor = views.reactions.accent;
        rxPercent.innerHTML = '0%';
        rxPhase.textContent = 'Reading history';

        await deleteReactions(authToken, channelId, startId, scanLimit, ignoreAuthorId, logger, () => !(rxStopped === true), onRxProgress);

        rxStopped = rxStopBtn.disabled = !(rxStartBtn.disabled = false);
        startBtn.disabled = false;
    };

    $('#redact').onchange = e => {
        popover.classList.toggle('redact') &&
            window.alert('This will attempt to hide personal information, but make sure to double check before sharing screenshots.');
    };

    const logger = (type = '', args) => {
        const style = {'': '', info: 'color:#00b0f4;', verb: 'color:#72767d;', warn: 'color:#faa61a;', error: 'color:#f04747;', success: 'color:#43b581;'}[type];
        logArea.insertAdjacentHTML('beforeend', `<div style="${style}">${Array.from(args).map(o => typeof o === 'object' ? JSON.stringify(o, o instanceof Error && Object.getOwnPropertyNames(o)) : o).join('\t')}</div>`);
        if (autoScroll.checked) logArea.querySelector('div:last-child').scrollIntoView(false);
    };

    // fixLocalStorage
    window.localStorage = document.body.appendChild(document.createElement('iframe')).contentWindow.localStorage;

}

initUI();
