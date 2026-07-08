from groq import Groq

from app.config import GROQ_API_KEY, GROQ_MODEL

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
) -> str:
    client = _get_client()
    if not client:
        return "AI assistant is not configured. Ask an administrator to set the GROQ_API_KEY."

    msgs = [{"role": "system", "content": system_prompt}] + messages

    try:
        chat_completion = client.chat.completions.create(
            model=GROQ_MODEL,
            messages=msgs,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return chat_completion.choices[0].message.content or ""
    except Exception as e:
        err_msg = str(e)
        if "429" in err_msg or "rate_limit" in err_msg.lower():
            return "The AI service is temporarily unavailable due to rate limiting. Please try again later."
        if "API_KEY" in err_msg or "unauthorized" in err_msg.lower() or "invalid" in err_msg.lower():
            return "The AI assistant is not properly configured. Please ask an administrator to check the GROQ_API_KEY."
        return "Sorry, I couldn't process your request. Please try again later."
