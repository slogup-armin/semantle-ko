/*
    Copyright (c) 2022, Newsjelly, forked from Semantlich by Johannes Gätjen semantlich.johannesgaetjen.de and Semantle by David Turner <novalis@novalis.org> semantle.novalis.org

    This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, version 3.

    This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

    You should have received a copy of the GNU General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/
'use strict';

let sharedGuesses = [];
let similarityStory = null;
let chronoForward = 1;
let guessSortMode = 'similarity';
let isComposingUserId = false;

const numPuzzles = 4650;
const initialDate = new Date('2022-04-01T00:00:00+09:00');
const puzzleNumber = Math.floor((new Date() - initialDate) / 86400000) % numPuzzles;
const yesterdayPuzzleNumber = (puzzleNumber + numPuzzles - 1) % numPuzzles;
const storage = window.localStorage;
const userIdStorageKey = 'sharedUserId';
let darkMode = storage.getItem('darkMode') === 'true';

function $(id) {
    if (id.charAt(0) !== '#') return false;
    return document.getElementById(id.substring(1));
}

function makeRandomSuffix() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function normalizeNickname(value) {
    return value.trim().replaceAll(' ', '').replace(/[^가-힣]/g, '').substring(0, 10);
}

function getStoredUserId() {
    const userId = storage.getItem(userIdStorageKey);
    if (userId == null || userId.trim() === '') {
        return null;
    }
    return userId;
}

function buildUserId(nickname) {
    const normalized = normalizeNickname(nickname);
    if (normalized === '') {
        return null;
    }
    return `${normalized}#${makeRandomSuffix()}`;
}

function saveUserId() {
    const input = $('#user-id-input');
    input.value = normalizeNickname(input.value);
    const nextUserId = buildUserId(input.value);
    if (nextUserId == null) {
        $('#error').textContent = '사용자 ID는 한글만 입력할 수 있습니다.';
        input.focus();
        return null;
    }
    storage.setItem(userIdStorageKey, nextUserId);
    $('#error').textContent = '';
    setUserIdDisplay();
    return nextUserId;
}

function ensureUserId() {
    return getStoredUserId();
}

function updateUserIdPromptState() {
    const panel = $('#user-id-panel');
    const input = $('#user-id-input');
    const guessInput = $('#guess');
    const needsUserId = getStoredUserId() == null;
    panel.classList.toggle('needs-attention', needsUserId);
    input.classList.toggle('needs-attention', needsUserId);
    if (needsUserId) {
        input.focus();
    } else {
        guessInput.focus();
    }
}

function setUserIdDisplay() {
    const userId = getStoredUserId();
    if (userId == null) {
        $('#user-id-display').textContent = '';
        $('#user-id-input').value = '';
        updateUserIdPromptState();
        return;
    }
    $('#user-id-input').value = userId.split('#')[0];
    $('#user-id-display').innerHTML = `현재 사용자 ID: <b>${userId}</b>`;
    updateUserIdPromptState();
}

function normalizeSharedGuess(entry) {
    return {
        similarity: entry.sim * 100.0,
        guess: entry.guess,
        percentile: entry.rank,
        order: entry.order,
        firstUserId: entry.first_user_id || '-',
        isCorrect: entry.sim === 1,
    };
}

function getSortedGuesses() {
    const guesses = sharedGuesses.slice();
    if (guessSortMode === 'chrono') {
        guesses.sort(function(a, b){return chronoForward * (a.order - b.order)});
    } else if (guessSortMode === 'alpha') {
        guesses.sort(function(a, b){return a.guess.localeCompare(b.guess)});
    } else {
        guesses.sort(function(a, b){return b.similarity - a.similarity});
    }
    return guesses;
}

function guessRow(entry, highlightedGuess) {
    let percentileText = entry.percentile;
    let progress = '';
    let closeClass = '';
    if (similarityStory != null && entry.similarity >= similarityStory.rest * 100 && entry.percentile === '1000위 이상') {
        percentileText = '<span class="weirdWord">????<span class="tooltiptext">이 단어는 사전에는 없지만, 데이터셋에 포함되어 있으며 1,000위 이내입니다.</span></span>';
    }
    if (typeof entry.percentile === 'number') {
        closeClass = 'close';
        percentileText = `<span class="percentile">${entry.percentile}</span>&nbsp;`;
        progress = ` <span class="progress-container">
<span class="progress-bar" style="width:${(1001 - entry.percentile)/10}%">&nbsp;</span>
</span>`;
    }
    let style = '';
    if (entry.guess === highlightedGuess) {
        style = 'style="color: #f7617a;font-weight: 600;"';
    }
    return `<tr><td>${entry.order}</td><td ${style}>${entry.guess}</td><td>${entry.similarity.toFixed(2)}</td><td class="${closeClass}">${percentileText}${progress}</td><td>${entry.firstUserId}</td></tr>`;
}

function renderLeaderboard() {
    const userBest = new Map();
    for (let entry of sharedGuesses) {
        const previous = userBest.get(entry.firstUserId);
        if (previous == null || entry.similarity > previous.similarity) {
            userBest.set(entry.firstUserId, entry);
        }
    }

    const ranking = Array.from(userBest.entries()).map(([userId, entry]) => ({
        userId,
        similarity: entry.similarity,
        guess: entry.guess,
        percentile: entry.percentile,
        isCorrect: entry.isCorrect,
    }));
    ranking.sort(function(a, b){return b.similarity - a.similarity});

    if (ranking.length === 0) {
        $('#leaderboard').innerHTML = '<p>아직 검색된 단어가 없습니다.</p>';
        return;
    }

    let inner = '<table><tr><th>순위</th><th>사용자 ID</th><th>최고 유사도 단어</th><th>유사도</th><th>순위</th></tr>';
    ranking.forEach(function(entry, index) {
        const rankText = entry.isCorrect ? '정답!' : entry.percentile;
        inner += `<tr><td>${index + 1}</td><td>${entry.userId}</td><td>${entry.guess}</td><td>${entry.similarity.toFixed(2)}</td><td>${rankText}</td></tr>`;
    });
    inner += '</table>';
    $('#leaderboard').innerHTML = inner;
}

function renderStatus() {
    const solvedEntry = sharedGuesses.find(entry => entry.isCorrect);
    if (solvedEntry == null) {
        $('#response').innerHTML = '';
        return;
    }

    $('#response').classList.add('gaveup');
    $('#response').innerHTML = `<p><b>정답 단어가 공개되었습니다: "${solvedEntry.guess}"</b><br/>최초로 찾은 사용자: ${solvedEntry.firstUserId}<br/>정답 단어와 비슷한, <a href="/nearest1k/${puzzleNumber}">상위 1,000개의 단어</a>를 확인해보세요.</p>`;
    // $('#give-up-btn').style = 'display:none;';
}

function updateGuesses(highlightedGuess = '') {
    const displayGuesses = getSortedGuesses();
    let inner = '<tr><th id="chronoOrder">#</th><th id="alphaOrder">추측한 단어</th><th id="similarityOrder">유사도</th><th>유사도 순위</th><th>최초 검색자</th></tr>';
    for (let entry of displayGuesses) {
        if (entry.guess === highlightedGuess) {
            inner += guessRow(entry, highlightedGuess);
        }
    }
    inner += '<tr><td colspan=5><hr></td></tr>';
    for (let entry of displayGuesses) {
        if (entry.guess !== highlightedGuess) {
            inner += guessRow(entry, highlightedGuess);
        }
    }
    $('#guesses').innerHTML = inner;
    $('#chronoOrder').addEventListener('click', function() {
        guessSortMode = 'chrono';
        chronoForward *= -1;
        updateGuesses(highlightedGuess);
    });
    $('#alphaOrder').addEventListener('click', function() {
        guessSortMode = 'alpha';
        chronoForward = 1;
        updateGuesses(highlightedGuess);
    });
    $('#similarityOrder').addEventListener('click', function() {
        guessSortMode = 'similarity';
        chronoForward = 1;
        updateGuesses(highlightedGuess);
    });
}

function toggleDarkMode(on) {
    document.body.classList[on ? 'add' : 'remove']('dark');
    const darkModeCheckbox = $('#dark-mode');
    darkMode = on;
    if (darkModeCheckbox) {
        darkModeCheckbox.checked = on;
    }
}

async function getSimilarityStory() {
    const response = await fetch('/similarity/' + puzzleNumber);
    try {
        return await response.json();
    } catch (e) {
        return null;
    }
}

async function getYesterday() {
    try {
        return (await fetch('/yesterday/' + puzzleNumber)).text();
    } catch (e) {
        return null;
    }
}

async function syncSharedGuesses(highlightedGuess = '') {
    const response = await fetch('/state/' + puzzleNumber);
    const state = await response.json();
    sharedGuesses = (state.guesses || []).map(normalizeSharedGuess);
    updateGuesses(highlightedGuess);
    renderLeaderboard();
    renderStatus();
}

async function submitGuess(word) {
    const userId = ensureUserId();
    if (userId == null) {
        return { error: 'missing_user_id' };
    }
    const response = await fetch('/guess/' + puzzleNumber + '/' + word + '?user_id=' + encodeURIComponent(userId));
    try {
        return await response.json();
    } catch (e) {
        return null;
    }
}

function openSettings() {
    document.body.classList.add('dialog-open', 'settings-open');
}

async function init() {
    setUserIdDisplay();
    $('#user-id-input').addEventListener('input', function(event) {
        if (isComposingUserId) {
            return;
        }
        event.target.value = normalizeNickname(event.target.value);
    });
    $('#user-id-input').addEventListener('compositionstart', function() {
        isComposingUserId = true;
    });
    $('#user-id-input').addEventListener('compositionend', function(event) {
        isComposingUserId = false;
        event.target.value = normalizeNickname(event.target.value);
    });
    $('#user-id-save').addEventListener('click', function() {
        saveUserId();
    });
    $('#user-id-input').addEventListener('keydown', function(event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            saveUserId();
        }
    });

    const yesterday = await getYesterday();
    $('#yesterday2').innerHTML = `어제의 정답 단어는 <b>"${yesterday}"</b>입니다.`;
    $('#yesterday-nearest1k').innerHTML = `정답 단어와 비슷한, <a href="/nearest1k/${yesterdayPuzzleNumber}">유사도 기준 상위 1,000개의 단어</a>를 확인할 수 있습니다.`;

    try {
        similarityStory = await getSimilarityStory();
        $('#similarity-story').innerHTML = `
            ${puzzleNumber}번째 꼬맨틀 협동전을 진행 중입니다.<br/>
            오늘 검색된 단어는 모든 참가자에게 공유됩니다.<br/>
            가장 유사한 단어의 유사도는 <b>${(similarityStory.top * 100).toFixed(2)}</b> 입니다.
            10번째로 유사한 단어의 유사도는 ${(similarityStory.top10 * 100).toFixed(2)}이고,
            1,000번째로 유사한 단어의 유사도는 ${(similarityStory.rest * 100).toFixed(2)} 입니다.`;
    } catch {
        // ignore
    }

    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        toggleDarkMode(darkMode);
    } else {
        toggleDarkMode(darkMode);
    }

    $('#settings-button').addEventListener('click', openSettings);
    document.querySelectorAll('.dialog-underlay, .dialog-close').forEach(function(el) {
        el.addEventListener('click', function() {
            document.body.classList.remove('dialog-open', 'settings-open');
        });
    });
    document.querySelectorAll('.dialog').forEach(function(el) {
        el.addEventListener('click', function(event) {
            event.stopPropagation();
        });
    });
    $('#dark-mode').addEventListener('click', function(event) {
        storage.setItem('darkMode', event.target.checked);
        toggleDarkMode(event.target.checked);
    });
    $('#dark-mode').checked = darkMode;

    await syncSharedGuesses();
    window.setInterval(function() {
        syncSharedGuesses();
    }, 5000);

    // $('#give-up-btn').addEventListener('click', async function() {
    //     if (!confirm('정답을 확인하시겠습니까?')) {
    //         return;
    //     }
    //     const secret = await (await fetch('/giveup/' + puzzleNumber)).text();
    //     $('#response').classList.add('gaveup');
    //     $('#response').innerHTML = `<p><b>오늘의 정답 단어는 "${secret}" 입니다.</b><br/>정답 단어와 비슷한, <a href="/nearest1k/${puzzleNumber}">상위 1,000개의 단어</a>를 확인해보세요.</p>`;
    // });

    $('#form').addEventListener('submit', async function(event) {
        event.preventDefault();
        $('#error').textContent = '';
        let guess = $('#guess').value.trim().replace('!', '').replace('*', '').replaceAll('/', '');
        if (!guess) {
            return false;
        }

        $('#guess').value = '';
        $('#dummy').focus();
        $('#guess').focus();

        const guessData = await submitGuess(guess);
        if (guessData == null) {
            $('#error').textContent = '서버가 응답하지 않습니다. 나중에 다시 시도해보세요.';
            return false;
        }
        if (guessData.error === 'missing_user_id') {
            $('#error').textContent = '먼저 사용자 ID를 입력하고 저장하세요.';
            $('#user-id-input').focus();
            return false;
        }
        if (guessData.error === 'unknown') {
            $('#error').textContent = `${guess}은(는) 알 수 없는 단어입니다.`;
            return false;
        }

        await syncSharedGuesses(guessData.guess);
        return false;
    });
}

window.addEventListener('load', init);
