# Executant: Mixing Deterministic & AI Steps

## Example: CoffeeScript → TypeScript Pipeline

```yaml
# Step 1: Bash runs conversion tool
- name: "convert"
  type: script
  self_healing: true
  command: coffee2ts convert app.coffee --with-deps --limit 3

# Step 2: AI fixes types and imports
- name: "fix_types"
  type: prompt
  llm_as_judge: true
    prompt: |
      For each file in converted-files.txt:
      - Add proper type annotations
      - Fix ES6 imports (convert to require() for CommonJS modules)
      - Verify logic matches original

# Step 3: Bash collects coverage data
- name: "check_coverage"
  type: script
  command: |
    while read -r file; do
      npx nyc --include="$file" npm test
      node -e "parse JSON, extract %" >> results.txt
    done < converted-files.txt
    awk '$3 < 80' results.txt > low-coverage.txt

# Step 4: AI writes tests
- name: "boost_coverage"
  type: prompt
  llm_as_judge: true
  prompt: |
    Read low-coverage.txt. For each file < 80%:
    - Analyze uncovered code paths
    - Write targeted tests
    - Run and verify coverage improved

# Step 5: Bash validates
- name: "verify"
  type: script
  command: npm run test:coverage && npm run lint
```

## Why This Works

| **Bash Steps** | **AI Steps** |
|----------------|--------------|
| Fast, cheap, deterministic | Intelligent, adaptive |
| Data collection, formatting | Analysis, code generation |
| No API cost | Costs tokens |
| Commands you already have | Reasoning you need |

## State Files Bridge The Gap

```bash
.claude/executant.local/
├── converted-files.txt      # Bash writes → AI reads
├── low-coverage-files.txt   # Bash writes → AI reads
└── coverage-table.txt       # Bash writes → AI inserts
```

## Quality Control Built-In

- `llm_as_judge: true` - AI evaluates AI's own output, retries if needed
- `self_healing: true` - Bash failures auto-fix via AI analysis
- Each step validates previous step's work

## Result

A 750-line pipeline that:
- Converts CoffeeScript → TypeScript
- Writes tests to hit 80% coverage
- Lints, validates, reviews changes
- All automated, all quality-checked
