import pickle
import sqlite3
from datetime import date, datetime, timedelta

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from flask import (
    Flask,
    request,
    send_file,
    send_from_directory,
    jsonify,
    render_template
)
from pytz import utc, timezone

import word2vec
from process_similar import get_nearest

KST = timezone('Asia/Seoul')

NUM_SECRETS = 4650
FIRST_DAY = date(2022, 4, 1)
SHARED_STATE_DB = 'data/shared_state.db'
SHARED_STATE_RETENTION_DAYS = 1
SHARED_STATE_OFFSETS = (-1, 0, 1)
scheduler = BackgroundScheduler()
scheduler.start()


def current_kst_datetime() -> datetime:
    return utc.localize(datetime.utcnow()).astimezone(KST)


def current_kst_date() -> date:
    return current_kst_datetime().date()


def get_puzzle_number(puzzle_date: date) -> int:
    return (puzzle_date - FIRST_DAY).days % NUM_SECRETS


def get_shared_state_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(SHARED_STATE_DB)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_shared_state_store() -> None:
    with get_shared_state_connection() as connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS shared_guesses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                puzzle_date TEXT NOT NULL,
                puzzle_number INTEGER NOT NULL,
                word TEXT NOT NULL,
                sim REAL NOT NULL,
                rank_int INTEGER,
                rank_text TEXT,
                first_user_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE (puzzle_date, word)
            )
        """)
        connection.execute("""
            CREATE INDEX IF NOT EXISTS idx_shared_guesses_puzzle_date
            ON shared_guesses (puzzle_date, puzzle_number, id)
        """)


def prune_shared_guesses(reference_date: date) -> None:
    cutoff = (reference_date - timedelta(days=SHARED_STATE_RETENTION_DAYS)).isoformat()
    with get_shared_state_connection() as connection:
        connection.execute("DELETE FROM shared_guesses WHERE puzzle_date < ?", (cutoff,))


def shared_guess_from_row(row: sqlite3.Row) -> dict:
    rank = row["rank_int"] if row["rank_int"] is not None else row["rank_text"]
    return {
        "guess": row["word"],
        "sim": row["sim"],
        "rank": rank,
        "first_user_id": row["first_user_id"],
        "created_at": row["created_at"]
    }


def load_shared_guesses_for_date(puzzle_date: date) -> dict:
    puzzle_number = get_puzzle_number(puzzle_date)
    with get_shared_state_connection() as connection:
        rows = connection.execute("""
            SELECT word, sim, rank_int, rank_text, first_user_id, created_at
            FROM shared_guesses
            WHERE puzzle_date = ? AND puzzle_number = ?
            ORDER BY id
        """, (puzzle_date.isoformat(), puzzle_number)).fetchall()
    return {row["word"]: shared_guess_from_row(row) for row in rows}


def persist_shared_guess(puzzle_date: date, entry: dict) -> dict:
    rank = entry["rank"]
    rank_int = rank if isinstance(rank, int) else None
    rank_text = rank if isinstance(rank, str) else None
    with get_shared_state_connection() as connection:
        connection.execute("""
            INSERT OR IGNORE INTO shared_guesses (
                puzzle_date,
                puzzle_number,
                word,
                sim,
                rank_int,
                rank_text,
                first_user_id,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            puzzle_date.isoformat(),
            get_puzzle_number(puzzle_date),
            entry["guess"],
            entry["sim"],
            rank_int,
            rank_text,
            entry["first_user_id"],
            entry["created_at"]
        ))
        row = connection.execute("""
            SELECT word, sim, rank_int, rank_text, first_user_id, created_at
            FROM shared_guesses
            WHERE puzzle_date = ? AND word = ?
        """, (puzzle_date.isoformat(), entry["guess"])).fetchone()
    return shared_guess_from_row(row)


def resolve_puzzle_date(day: int) -> date:
    today = current_kst_date()
    for offset in SHARED_STATE_OFFSETS:
        candidate = today + timedelta(days=offset)
        if get_puzzle_number(candidate) == day:
            return candidate
    return today


def restore_shared_guesses(reference_date=None) -> None:
    if reference_date is None:
        reference_date = current_kst_date()
    prune_shared_guesses(reference_date)
    retained_puzzles = set()
    for offset in SHARED_STATE_OFFSETS:
        puzzle_date = reference_date + timedelta(days=offset)
        puzzle_number = get_puzzle_number(puzzle_date)
        app.shared_guesses[puzzle_number] = load_shared_guesses_for_date(puzzle_date)
        retained_puzzles.add(puzzle_number)
    for puzzle_number in list(app.shared_guesses):
        if puzzle_number not in retained_puzzles:
            del app.shared_guesses[puzzle_number]


app = Flask(__name__)
print("loading valid nearest")
with open('data/valid_nearest.dat', 'rb') as f:
    valid_nearest_words, valid_nearest_vecs = pickle.load(f)
with open('data/secrets.txt', 'r', encoding='utf-8') as f:
    secrets = [l.strip() for l in f.readlines()]
print("initializing nearest words for solutions")
app.secrets = dict()
app.nearests = dict()
app.shared_guesses = dict()
initialize_shared_state_store()
current_puzzle = get_puzzle_number(current_kst_date())
for offset in range(-2, 2):
    puzzle_number = (current_puzzle + offset) % NUM_SECRETS
    secret_word = secrets[puzzle_number]
    app.secrets[puzzle_number] = secret_word
    app.nearests[puzzle_number] = get_nearest(puzzle_number, secret_word, valid_nearest_words, valid_nearest_vecs)
restore_shared_guesses()


@scheduler.scheduled_job(trigger=CronTrigger(hour=1, minute=0, timezone=KST))
def update_nearest():
    print("scheduled stuff triggered!")
    today = current_kst_date()
    next_puzzle = get_puzzle_number(today + timedelta(days=1))
    next_word = secrets[next_puzzle]
    to_delete = (next_puzzle - 4) % NUM_SECRETS
    if to_delete in app.secrets:
        del app.secrets[to_delete]
    if to_delete in app.nearests:
        del app.nearests[to_delete]
    app.secrets[next_puzzle] = next_word
    app.nearests[next_puzzle] = get_nearest(next_puzzle, next_word, valid_nearest_words, valid_nearest_vecs)
    restore_shared_guesses(today)


def build_guess_response(day: int, word: str) -> dict:
    if app.secrets[day] == word:
        word = app.secrets[day]
    rtn = {"guess": word}
    if day in app.nearests and word in app.nearests[day]:
        rtn["sim"] = app.nearests[day][word][1]
        rtn["rank"] = app.nearests[day][word][0]
    else:
        rtn["sim"] = word2vec.similarity(app.secrets[day], word)
        rtn["rank"] = "1000위 이상"
    return rtn


@app.route('/')
def get_index():
    return render_template('index.html')


@app.route('/robots.txt')
def robots():
    return send_file("static/assets/robots.txt")


@app.route("/favicon.ico")
def send_favicon():
    return send_file("static/assets/favicon.ico")


@app.route("/assets/<path:path>")
def send_static(path):
    return send_from_directory("static/assets", path)


@app.route('/guess/<int:day>/<string:word>')
def get_guess(day: int, word: str):
    user_id = (request.args.get('user_id', '').strip() or '익명')[:32]
    puzzle_date = resolve_puzzle_date(day)
    shared_day = app.shared_guesses.setdefault(day, load_shared_guesses_for_date(puzzle_date))
    if word in shared_day:
        return jsonify(shared_day[word])
    try:
        computed = build_guess_response(day, word)
    except KeyError:
        return jsonify({"error": "unknown"}), 404

    if computed["guess"] in shared_day:
        return jsonify(shared_day[computed["guess"]])
    entry = {
        **computed,
        "first_user_id": user_id,
        "created_at": current_kst_datetime().isoformat()
    }
    actual = persist_shared_guess(puzzle_date, entry)
    shared_day.setdefault(actual["guess"], actual)
    return jsonify(actual)


@app.route('/state/<int:day>')
def get_state(day: int):
    if day not in app.shared_guesses:
        app.shared_guesses[day] = load_shared_guesses_for_date(resolve_puzzle_date(day))
    guesses = [
        dict(entry, order=index + 1)
        for index, entry in enumerate(app.shared_guesses[day].values())
    ]
    return jsonify({"guesses": guesses})


@app.route('/similarity/<int:day>')
def get_similarity(day: int):
    nearest_dists = sorted([v[1] for v in app.nearests[day].values()])
    return jsonify({"top": nearest_dists[-2], "top10": nearest_dists[-11], "rest": nearest_dists[0]})


@app.route('/yesterday/<int:today>')
def get_solution_yesterday(today: int):
    return app.secrets[(today - 1) % NUM_SECRETS]


@app.route('/nearest1k/<int:day>')
def get_nearest_1k(day: int):
    if day not in app.secrets:
        return "이 날의 가장 유사한 단어는 현재 사용할 수 없습니다. 그저께부터 내일까지만 확인할 수 있습니다.", 404
    solution = app.secrets[day]
    words = [
        dict(
            word=w,
            rank=k[0],
            similarity="%0.2f" % (k[1] * 100))
        for w, k in app.nearests[day].items() if w != solution]
    return render_template('top1k.html', word=solution, words=words, day=day)


@app.route('/giveup/<int:day>')
def give_up(day: int):
    if day not in app.secrets:
        return '저런...', 404
    else:
        return app.secrets[day]
