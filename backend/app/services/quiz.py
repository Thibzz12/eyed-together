"""Logique métier des quiz : passation, correction automatique, classement."""

import json
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.db import models as m
from app.services.gamification import award_points

POINTS_PER_CORRECT_ANSWER = 2


class QuizError(Exception):
    status_code = 400


class QuizNotFound(QuizError):
    status_code = 404


class AlreadyAttempted(QuizError):
    status_code = 409


def _is_published(quiz: m.Quiz) -> bool:
    return quiz.publish_at is None or quiz.publish_at <= datetime.now(timezone.utc)


def list_published_quizzes(db: Session, user_id: int) -> list[dict]:
    """Quiz publiés, avec mon statut (déjà passé ou non, mon score)."""
    quizzes = db.scalars(
        select(m.Quiz).options(joinedload(m.Quiz.questions))
    ).unique()
    out = []
    for q in quizzes:
        if not _is_published(q):
            continue
        my_attempt = db.scalar(
            select(m.QuizAttempt).where(m.QuizAttempt.quiz_id == q.id, m.QuizAttempt.user_id == user_id)
        )
        out.append({
            "id": q.id, "title": q.title, "description": q.description,
            "question_count": len(q.questions),
            "my_score": my_attempt.score if my_attempt else None,
            "my_total": my_attempt.total if my_attempt else None,
            "completed": my_attempt is not None,
        })
    return out


def get_quiz_for_attempt(db: Session, quiz_id: int, user_id: int) -> dict:
    """Le quiz à passer (SANS révéler les bonnes réponses) — ou la correction si déjà passé."""
    quiz = db.get(m.Quiz, quiz_id)
    if quiz is None or not _is_published(quiz):
        raise QuizNotFound("Quiz introuvable.")

    my_attempt = db.scalar(
        select(m.QuizAttempt).where(m.QuizAttempt.quiz_id == quiz_id, m.QuizAttempt.user_id == user_id)
    )
    questions = db.scalars(
        select(m.QuizQuestion).where(m.QuizQuestion.quiz_id == quiz_id)
        .order_by(m.QuizQuestion.position).options(joinedload(m.QuizQuestion.choices))
    ).unique()

    if my_attempt:
        chosen = json.loads(my_attempt.answers_json or "{}")
        return {
            "id": quiz.id, "title": quiz.title, "description": quiz.description,
            "completed": True, "score": my_attempt.score, "total": my_attempt.total,
            "questions": [
                {
                    "id": qq.id, "text": qq.text,
                    "choices": [
                        {
                            "id": c.id, "text": c.text, "is_correct": c.is_correct,
                            "chosen": chosen.get(str(qq.id)) == c.id,
                        } for c in qq.choices
                    ],
                } for qq in questions
            ],
        }
    return {
        "id": quiz.id, "title": quiz.title, "description": quiz.description,
        "completed": False, "score": None, "total": None,
        "questions": [
            {"id": qq.id, "text": qq.text, "choices": [{"id": c.id, "text": c.text} for c in qq.choices]}
            for qq in questions
        ],
    }


def submit_attempt(db: Session, quiz_id: int, user_id: int, answers: dict[int, int]) -> m.QuizAttempt:
    """Corrige automatiquement et enregistre la tentative. `answers` = {question_id: choice_id}."""
    quiz = db.get(m.Quiz, quiz_id)
    if quiz is None or not _is_published(quiz):
        raise QuizNotFound("Quiz introuvable.")
    if db.scalar(select(m.QuizAttempt).where(m.QuizAttempt.quiz_id == quiz_id, m.QuizAttempt.user_id == user_id)):
        raise AlreadyAttempted("Tu as déjà répondu à ce quiz.")

    questions = list(db.scalars(
        select(m.QuizQuestion).where(m.QuizQuestion.quiz_id == quiz_id).options(joinedload(m.QuizQuestion.choices))
    ).unique())

    score = 0
    for qq in questions:
        chosen_id = answers.get(qq.id)
        correct_choice = next((c for c in qq.choices if c.is_correct), None)
        if chosen_id is not None and correct_choice is not None and chosen_id == correct_choice.id:
            score += 1

    attempt = m.QuizAttempt(
        quiz_id=quiz_id, user_id=user_id, score=score, total=len(questions),
        answers_json=json.dumps({str(k): v for k, v in answers.items()}),
    )
    db.add(attempt)
    if score > 0:
        award_points(db, user_id, score * POINTS_PER_CORRECT_ANSWER, "quiz_correct_answers")
    db.commit()
    db.refresh(attempt)
    return attempt


def leaderboard(db: Session, quiz_id: int) -> list[dict]:
    """Classement d'un quiz, meilleurs scores en tête."""
    rows = db.scalars(
        select(m.QuizAttempt).where(m.QuizAttempt.quiz_id == quiz_id)
        .order_by(m.QuizAttempt.score.desc(), m.QuizAttempt.completed_at)
        .options(joinedload(m.QuizAttempt.user))
    )
    return [{"name": r.user.display_name, "score": r.score, "total": r.total} for r in rows]


# --------------------------------------------------------------------------
#  Administration
# --------------------------------------------------------------------------
def admin_list_quizzes(db: Session) -> list[dict]:
    quizzes = db.scalars(select(m.Quiz).order_by(m.Quiz.created_at.desc()).options(joinedload(m.Quiz.questions)))
    out = []
    for q in quizzes.unique():
        attempt_count = db.scalar(
            select(func.count()).select_from(m.QuizAttempt).where(m.QuizAttempt.quiz_id == q.id)
        ) or 0
        out.append({
            "id": q.id, "title": q.title, "description": q.description,
            "publish_at": q.publish_at.isoformat() if q.publish_at else None,
            "question_count": len(q.questions), "attempt_count": attempt_count,
        })
    return out


def create_quiz(db: Session, title: str, description: str | None, publish_at: datetime | None) -> m.Quiz:
    quiz = m.Quiz(title=title, description=description, publish_at=publish_at)
    db.add(quiz)
    db.commit()
    db.refresh(quiz)
    return quiz


def delete_quiz(db: Session, quiz_id: int) -> None:
    quiz = db.get(m.Quiz, quiz_id)
    if quiz is not None:
        db.delete(quiz)
        db.commit()


def add_question(db: Session, quiz_id: int, text: str, qtype: str, choices: list[dict]) -> m.QuizQuestion:
    """`choices` = [{"text": str, "is_correct": bool}, ...]"""
    quiz = db.get(m.Quiz, quiz_id)
    if quiz is None:
        raise QuizNotFound("Quiz introuvable.")
    position = db.scalar(
        select(func.count()).select_from(m.QuizQuestion).where(m.QuizQuestion.quiz_id == quiz_id)
    ) or 0
    question = m.QuizQuestion(quiz_id=quiz_id, text=text, type=m.QuestionType(qtype), position=position)
    db.add(question)
    db.flush()
    for i, c in enumerate(choices):
        db.add(m.QuizChoice(question_id=question.id, text=c["text"], is_correct=bool(c.get("is_correct")), position=i))
    db.commit()
    db.refresh(question)
    return question


def delete_question(db: Session, question_id: int) -> None:
    question = db.get(m.QuizQuestion, question_id)
    if question is not None:
        db.delete(question)
        db.commit()
