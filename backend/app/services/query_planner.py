"""
Query Planner — Phase 1 of the RAG pipeline.

The Planner constructs a system prompt that teaches the LLM how to:
  1. Understand the user's role and what tools are available
  2. Extract entity names (properties, locations, doc types) from the message
  3. Output a structured JSON plan that the Query Executor can validate and execute

The prompt is role-aware — customers see different tools than admins.
The PlanParser validates the LLM's raw JSON output against a strict schema.
"""

import json
import logging
from typing import Any

from app.models.db_models import DocType
from app.services.query_tools import format_tools_for_planner

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════════════
# 1.  PLANNER SYSTEM PROMPT TEMPLATE
# ═══════════════════════════════════════════════════════════════════════════

PLANNER_SYSTEM_PROMPT = """\
You are the Query Planner for the HRMS (Hotel Room Management System) platform.
Your job is to analyze a user's message and produce a structured plan that the
system can execute.

──────────────────────────────────────────────────────────────────────────
ROLE CONTEXT
──────────────────────────────────────────────────────────────────────────

You are assisting a **{role_name}** user.

{role_rules}

──────────────────────────────────────────────────────────────────────────
CONVERSATION HISTORY
──────────────────────────────────────────────────────────────────────────

{history}

──────────────────────────────────────────────────────────────────────────
USER MESSAGE
──────────────────────────────────────────────────────────────────────────

"{message}"

──────────────────────────────────────────────────────────────────────────
INSTRUCTIONS
──────────────────────────────────────────────────────────────────────────

Your task is to produce a JSON plan with two sections:

### PART 1 — RESOLVE ENTITIES
Look at the user's message and extract:
  - **Property names** — any hotel, resort, or property names mentioned
    (e.g. "Lemon Tree", "Grand Plaza", "The Taj Mahal Palace")
  - **Locations** — any cities, states, districts, or countries mentioned
    (e.g. "Gurugram", "Goa", "Manali", "Kerala")
  - **Document types** — any document categories mentioned
    Valid types: {valid_doc_types_str}

Only include names that are explicitly mentioned or clearly implied by context.
If nothing is mentioned, leave the array empty.

### PART 2 — QUERIES
Based on the user's message, the conversation history, and your role,
decide what data is needed. You may choose ONE tool or MULTIPLE tools
if the question requires data from different sources. If the question has
two distinct information needs (e.g. "show my bookings AND their cancellation
policies"), include TWO queries in the array.

Available tools:

{formatted_tools}

### ROLE-SPECIFIC RULES

{role_specific_instructions}

**Tip for compound questions:** If the user asks something like
"show my bookings and their cancellation policies",
you need BOTH CUSTOMER_BOOKINGS (to get your booking data) AND
VECTOR_SEARCH (to look up the policies). Always check whether the
question needs data from documents + database combined, and include
multiple queries in the array when appropriate.

──────────────────────────────────────────────────────────────────────────
OUTPUT FORMAT
──────────────────────────────────────────────────────────────────────────

Respond with ONLY the JSON object below. No markdown, no explanation,
no extra text — just valid JSON.

The "queries" array can have ONE entry for simple questions, or
MULTIPLE entries for compound questions.

Example — simple question (one tool):
{{
  "resolve": {{
    "property_names": ["Grand Plaza"],
    "locations": [],
    "doc_types": []
  }},
  "queries": [
    {{
      "type": "tool",
      "name": "VECTOR_SEARCH",
      "params": {{
        "query": "What are the pool hours?",
        "limit": 6
      }}
    }}
  ]
}}

Example — compound question (multiple tools):
{{
  "resolve": {{
    "property_names": [],
    "locations": [],
    "doc_types": ["cancellation_policy"]
  }},
  "queries": [
    {{
      "type": "tool",
      "name": "CUSTOMER_BOOKINGS",
      "params": {{
        "status": "confirmed",
        "limit": 5
      }}
    }},
    {{
      "type": "tool",
      "name": "VECTOR_SEARCH",
      "params": {{
        "query": "cancellation policy",
        "limit": 6
      }}
    }}
  ]
}}
"""


# ═══════════════════════════════════════════════════════════════════════════
# 2.  ROLE-SPECIFIC CONFIGURATIONS
# ═══════════════════════════════════════════════════════════════════════════

def _role_name(role: str | None) -> str:
    """Pretty-print a role for the prompt."""
    if role is None:
        return "Guest (not logged in)"
    return role.replace("_", " ").title()


ROLE_RULES: dict[str | None, str] = {
    None: (
        "You are a guest user browsing the platform. You can search approved "
        "properties and ask about their policies, amenities, and documents. "
        "You cannot see your own bookings or any private data."
    ),
    "customer": (
        "You are a customer (traveler) browsing the platform. You can search "
        "approved properties, ask about policies, check your own bookings, "
        "and get recommendations. You CANNOT modify any data."
    ),
    "hotel_rep": (
        "You are a hotel representative managing properties on the platform. "
        "You have access to your own properties, rooms, availability, bookings, "
        "reviews, and uploaded documents. You CANNOT access other reps' data "
        "or modify platform-level settings."
    ),
    "admin": (
        "You are an administrator with full platform access. You can view all "
        "properties, approve/reject hotel registrations, activate/deactivate "
        "hotel reps, and run any query. Any mutation action requires user "
        "confirmation before execution."
    ),
}


def _role_specific_instructions(role: str | None) -> str:
    """Build the role-specific rules section of the prompt."""
    instructions = {
        None: (
            "1. You can search any approved property for pricing, policies, "
            "and availability.\n"
            "2. Use VECTOR_SEARCH for questions about policies, house rules, "
            "local guides, and amenities.\n"
            "3. You CANNOT modify any data.\n"
            "4. If no property or location is mentioned, do a broad search."
        ),
        "customer": (
            "1. You can search any approved property.\n"
            "2. Use VECTOR_SEARCH for questions about policies, cancellation, "
            "house rules, local guides, and transportation.\n"
            "3. Use CUSTOMER_BOOKINGS for questions about "
            "'my bookings', 'my reservations', 'booking history', "
            "or 'my upcoming stays'.\n"
            "4. You CANNOT modify any data.\n"
            "5. If no property or location is mentioned, do a broad search."
        ),
        "hotel_rep": (
            "1. You can only access data belonging to your own properties.\n"
            "2. Use REP_PROPERTIES when the user asks 'my properties', "
            "'my hotels', or 'list my places'.\n"
            "3. Use REP_AVAILABILITY_TODAY for questions about "
            "'room availability', 'rooms available today', 'how many rooms'.\n"
            "4. Use REP_BOOKINGS for questions about "
            "'my bookings', 'recent bookings', 'booking revenue', "
            "'how many bookings'.\n"
            "5. Use REP_REVIEWS for questions about "
            "'my reviews', 'guest feedback', 'review summary', "
            "'unanswered reviews'.\n"
            "6. Use REP_DOCUMENTS for questions about "
            "'my documents', 'uploaded policies', 'my uploaded files'.\n"
            "7. Use VECTOR_SEARCH for policy or amenity questions scoped "
            "to your own properties.\n"
            "8. You CANNOT access other reps' data or modify platform settings."
        ),
        "admin": (
            "1. You can view ALL platform data.\n"
            "2. Use VECTOR_SEARCH for policy or document questions across "
            "any property.\n"
            "3. Use ADMIN_STATISTICS for platform-wide stats like "
            "'total properties', 'total rooms', 'how many users'.\n"
            "4. Use ADMIN_PENDING_REGISTRATIONS for questions about "
            "'pending registrations', 'pending hotels', or 'approvals'.\n"
            "5. Use ADMIN_REP_LIST for questions about "
            "'hotel reps', 'list representatives', or to find a rep's UUID.\n"
            "6. Use MUTATION_APPROVE_HOTEL to approve a pending registration.\n"
            "7. Use MUTATION_REJECT_HOTEL to reject a pending registration.\n"
            "8. Use MUTATION_ACTIVATE_REP to reactivate a deactivated rep.\n"
            "9. Use MUTATION_DEACTIVATE_REP to deactivate an active rep.\n"
            "10. All mutation tools REQUIRE user confirmation. The Answer "
            "Generator should ask the user to confirm before proceeding.\n"
            "11. For pending registrations, mention them with details so the "
            "Answer Generator can embed [PendingHotel: <uuid> | <name> | <email>] "
            "markup for interactive buttons."
        ),
    }
    return instructions.get(role, instructions[None])


# Derive valid doc types from the enum to stay in sync with the DB
VALID_DOC_TYPES_LIST = sorted(t.value for t in DocType)


# ═══════════════════════════════════════════════════════════════════════════
# 3.  BUILD THE PLANNER PROMPT
# ═══════════════════════════════════════════════════════════════════════════

def build_planner_prompt(
    message: str,
    history: list[dict],
    role: str | None = None,
) -> str:
    """Build the full Planner system prompt for the given message and role.

    Args:
        message: The user's current message.
        history: List of {'role', 'content'} dicts from conversation history.
        role: The user's role string (from UserRole enum), or None for guests.

    Returns:
        A formatted system prompt ready to send to the LLM.
    """
    formatted_tools = format_tools_for_planner(role)

    # Format conversation history — keep it compact
    if history:
        # Show the last 6 messages max to avoid token overflow
        recent = history[-6:]
        history_lines = []
        for m in recent:
            role_label = "User" if m["role"] == "user" else "Assistant"
            content = m["content"][:300]  # Truncate long messages
            history_lines.append(f"{role_label}: {content}")
        history_str = "\n".join(history_lines)
    else:
        history_str = "(No prior conversation in this session.)"

    return PLANNER_SYSTEM_PROMPT.format(
        role_name=_role_name(role),
        role_rules=ROLE_RULES.get(role, ROLE_RULES[None]),
        history=history_str,
        message=message,
        valid_doc_types_str=", ".join(VALID_DOC_TYPES_LIST),
        formatted_tools=formatted_tools,
        role_specific_instructions=_role_specific_instructions(role),
    )


# ═══════════════════════════════════════════════════════════════════════════
# 4.  PLAN SCHEMA VALIDATION
# ═══════════════════════════════════════════════════════════════════════════

REQUIRED_TOOLS = {"VECTOR_SEARCH"}
CUSTOMER_TOOLS = {
    "CUSTOMER_BOOKINGS",
}
HOTEL_REP_TOOLS = {
    "REP_PROPERTIES", "REP_AVAILABILITY_TODAY", "REP_BOOKINGS",
    "REP_REVIEWS", "REP_DOCUMENTS",
}
ADMIN_MUTATION_TOOLS = {
    "MUTATION_APPROVE_HOTEL", "MUTATION_REJECT_HOTEL",
    "MUTATION_ACTIVATE_REP", "MUTATION_DEACTIVATE_REP",
}
ADMIN_QUERY_TOOLS = {
    "ADMIN_PENDING_REGISTRATIONS",
    "ADMIN_STATISTICS",
    "ADMIN_REP_LIST",
}

ALL_VALID_TOOLS = (
    REQUIRED_TOOLS
    | CUSTOMER_TOOLS
    | HOTEL_REP_TOOLS
    | ADMIN_MUTATION_TOOLS
    | ADMIN_QUERY_TOOLS
)


def _validate_plan_structure(plan: Any) -> list[str]:
    """Validate the structure of a parsed plan.

    Returns a list of error strings. An empty list means valid.
    """
    errors: list[str] = []

    if not isinstance(plan, dict):
        return ["Expected a JSON object at the top level"]

    # ── Validate "resolve" ──
    resolve = plan.get("resolve")
    if resolve is None:
        errors.append("Missing 'resolve' key")
    elif not isinstance(resolve, dict):
        errors.append("'resolve' must be a JSON object")
    else:
        for key in ("property_names", "locations", "doc_types"):
            val = resolve.get(key)
            if val is None:
                errors.append(f"Missing '{key}' in resolve")
            elif not isinstance(val, list):
                errors.append(f"'{key}' in resolve must be a JSON array")
            else:
                for item in val:
                    if not isinstance(item, str):
                        errors.append(f"Each item in resolve['{key}'] must be a string, got {type(item).__name__}")
                        break

    # ── Validate "queries" ──
    queries = plan.get("queries")
    if queries is None:
        errors.append("Missing 'queries' key")
    elif not isinstance(queries, list):
        errors.append("'queries' must be a JSON array")
    elif len(queries) == 0:
        errors.append("'queries' array is empty — at least one query is required")
    else:
        for i, query in enumerate(queries):
            if not isinstance(query, dict):
                errors.append(f"queries[{i}]: expected a JSON object")
                continue

            qtype = query.get("type")
            if qtype != "tool":
                errors.append(f"queries[{i}]: 'type' must be \"tool\", got {qtype!r}")

            name = query.get("name")
            if not name or not isinstance(name, str):
                errors.append(f"queries[{i}]: missing or invalid 'name'")
            elif name not in ALL_VALID_TOOLS:
                errors.append(
                    f"queries[{i}]: unknown tool '{name}'. "
                    f"Valid tools: {', '.join(sorted(ALL_VALID_TOOLS))}"
                )

            params = query.get("params")
            if params is None:
                errors.append(f"queries[{i}]: missing 'params' key")
            elif not isinstance(params, dict):
                errors.append(f"queries[{i}]: 'params' must be a JSON object")

    return errors


# ═══════════════════════════════════════════════════════════════════════════
# 5.  PARSE THE PLAN
# ═══════════════════════════════════════════════════════════════════════════

class PlanParseError(ValueError):
    """Raised when the LLM's plan output cannot be parsed or validated."""
    pass


def parse_plan(raw_output: str) -> dict:
    """Parse and validate the LLM's raw JSON plan output.

    Steps:
      1. Strips markdown code fences if present
      2. Parses the JSON
      3. Validates the structure against the expected schema
      4. Returns the validated plan dict

    Args:
        raw_output: The raw string returned by the LLM.

    Returns:
        A validated plan dict with 'resolve' and 'queries' keys.

    Raises:
        PlanParseError: If parsing or validation fails.
    """
    # ── Step 1: Strip markdown fences ──
    cleaned = raw_output.strip()
    if cleaned.startswith("```"):
        # Remove opening fence and optional language tag
        first_newline = cleaned.index("\n")
        cleaned = cleaned[first_newline:].strip()
        # Remove closing fence
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3].strip()

    # ── Step 2: Try to extract JSON if wrapped in text ──
    # Some LLMs add preamble before the JSON. Try to find the first '{'
    first_brace = cleaned.find("{")
    last_brace = cleaned.rfind("}")

    if first_brace == -1 or last_brace == -1 or first_brace >= last_brace:
        raise PlanParseError(
            "Could not find a JSON object in the LLM output. "
            f"Output starts with: {cleaned[:200]}"
        )

    json_str = cleaned[first_brace:last_brace + 1]

    # ── Step 3: Parse JSON ──
    try:
        plan = json.loads(json_str)
    except json.JSONDecodeError as e:
        raise PlanParseError(
            f"Failed to parse JSON plan: {e}\n"
            f"Extracted JSON (first 500 chars): {json_str[:500]}"
        )

    # ── Step 4: Validate structure ──
    errors = _validate_plan_structure(plan)
    if errors:
        raise PlanParseError(
            "Plan validation failed:\n  - " + "\n  - ".join(errors)
            + f"\n\nReceived JSON: {json.dumps(plan, indent=2)}"
        )

    return plan


# ═══════════════════════════════════════════════════════════════════════════
# 6.  HIGH-LEVEL API
# ═══════════════════════════════════════════════════════════════════════════

def prepare_planner_call(
    message: str,
    history: list[dict],
    role: str | None = None,
) -> dict:
    """Prepare the LLM call for Phase 1 (Query Planning).

    This is a convenience function that builds the prompt AND prepares
    the message list that the Query Executor can pass directly to ask_llm().

    Args:
        message: The user's current message.
        history: The full conversation history (list of {'role', 'content'}).
        role: The user's role, or None for guests.

    Returns:
        dict with 'system_prompt' (str) and 'messages' (list[dict]).
    """
    system_prompt = build_planner_prompt(message, history, role=role)

    # The planner only needs the current user message — the system prompt
    # already contains the conversation history inlined.
    messages = [{"role": "user", "content": message}]

    return {
        "system_prompt": system_prompt,
        "messages": messages,
    }
