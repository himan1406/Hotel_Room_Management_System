import logging
import os
import tempfile
import speech_recognition as sr
from pydub import AudioSegment

from groq import Groq

from app.core.config import GROQ_API_KEY, GROQ_MODEL

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

def transcribe_audio(file_path: str) -> str:
    recognizer = sr.Recognizer()
    
    try:
        # Convert webm/mp4 to wav using pydub
        audio = AudioSegment.from_file(file_path)
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as wav_file:
            wav_path = wav_file.name
            
        audio.export(wav_path, format="wav")
        
        try:
            with sr.AudioFile(wav_path) as source:
                audio_data = recognizer.record(source)
                
            # recognize using google free API
            text = recognizer.recognize_google(audio_data)
            return text
        finally:
            if os.path.exists(wav_path):
                os.remove(wav_path)
                
    except Exception as e:
        logger.error(f"Speech recognition error: {e}")
        return ""
