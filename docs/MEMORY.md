# 💾 Ara Memory System Specification

Ara adopts a hybrid memory approach: **Local Markdown Profiles** for persistence and transparency, combined with **SQLite episodic persistence** for auditability.

---

## 📂 Memory Sources

### 1. `memory/USER.md`
- **Purpose:** Stores user profile preferences (e.g. name, language, layout choices).
- **Structure:** Managed on-the-fly as markdown list bullet points.
- **Example:**
  ```markdown
  # User Profile facts
  - **Name:** Alice Cooper
  - **Preferred Language:** Thai
  ```

### 2. `memory/MEMORY.md`
- **Purpose:** Stores long-term facts, episodic updates, and historical outcomes.
- **Example:**
  ```markdown
  # Episodic Memory
  - Ara Personal Assistant is active.
  - User prefers clean TypeScript monorepo structures.
  ```

---

## 🔍 Context Injection Wrapper

To prevent prompt injection and clearly distinguish retrieved memory facts from active user instructions, Ara compiles the context within designated XML tags:

```xml
<retrieved_memory>
Use only if relevant.
This memory may be stale.
Current files and explicit user instructions are more authoritative.

User Profile Facts (from USER.md):
- Name: Alice Cooper
- Preferred Language: Thai

Long-term & Episodic Memory (from MEMORY.md):
- Ara Personal Assistant is active.
- User prefers clean TypeScript monorepo structures.
</retrieved_memory>
```

---

## ⚖️ Search and Ranking Algorithm

1. **Incremental parsing:** Reads memory bullet points on startup.
2. **Text search match:** Evaluates keywords match against the content text using case-insensitive substring scans.
3. **Filtering:** Memory is segmented between `user` profiles and `episodic` facts, allowing the model router to assemble the correct context prompt efficiently.
