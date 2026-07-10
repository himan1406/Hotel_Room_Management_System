import logging

from groq import Groq

from app.config import GROQ_API_KEY, GROQ_MODEL

logger = logging.getLogger(__name__)

_client = None


def _get_client():
    global _client
    if _client is None and GROQ_API_KEY:
        _client = Groq(api_key=GROQ_API_KEY)
    return _client


def ask_llm(
    system_prompt: str,
    messages: list[dict],
    temperature: float = 0.3,
    max_tokens: int = 1024,
) -> tuple[str, list | None]:
    client = _get_client()
    if not client:
        return "AI assistant is not configured. Ask an administrator to set the GROQ_API_KEY.", None

    msgs = [{"role": "system", "content": system_prompt}] + messages

    try:
        chat_completion = client.chat.completions.create(
            model=GROQ_MODEL,
            messages=msgs,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        content = chat_completion.choices[0].message.content or ""
        return content, None
    except Exception as e:
        err_msg = str(e)
        logger.error(f"Groq API error: {err_msg}")
        if "429" in err_msg or "rate_limit" in err_msg.lower():
            return "The AI service is temporarily unavailable due to rate limiting. Please try again later.", None
        if "API_KEY" in err_msg or "unauthorized" in err_msg.lower() or "invalid" in err_msg.lower():
            return "The AI assistant is not properly configured. Please ask an administrator to check the GROQ_API_KEY.", None
        return "Sorry, I couldn't process your request. Please try again later.", None
