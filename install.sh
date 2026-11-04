#!/usr/bin/env bash
set -euo pipefail

SKILL_NAME="t3-mission-mode"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANONICAL_DIR="${HOME}/.agents/skills/${SKILL_NAME}"

echo "Installing ${SKILL_NAME}..."

mkdir -p "${HOME}/.agents/skills"

if [ "${SCRIPT_DIR}" != "${CANONICAL_DIR}" ]; then
  if [ -d "${CANONICAL_DIR}/.git" ]; then
    find "${CANONICAL_DIR}" -mindepth 1 -maxdepth 1 ! -name ".git" -exec rm -rf {} +
    tar -C "${SCRIPT_DIR}" --exclude=".git" -cf - . | tar -C "${CANONICAL_DIR}" -xf -
  else
    rm -rf "${CANONICAL_DIR}"
    cp -R "${SCRIPT_DIR}" "${CANONICAL_DIR}"
    rm -rf "${CANONICAL_DIR}/.git"
  fi
  echo "  -> Installed canonical skill to ${CANONICAL_DIR}"
else
  echo "  -> Already running from canonical skill path ${CANONICAL_DIR}"
fi

# Keep an existing readiness installation; link the bundled copy when absent.
READINESS_SKILLS=(agent-readiness readiness-report readiness-fix)
for readiness_skill in "${READINESS_SKILLS[@]}"; do
  bundled_dir="${CANONICAL_DIR}/bundled-skills/${readiness_skill}"
  if [ ! -f "${bundled_dir}/SKILL.md" ]; then
    echo "Missing bundled skill: ${bundled_dir}" >&2
    exit 1
  fi
  readiness_dir="${HOME}/.agents/skills/${readiness_skill}"
  if [ ! -e "${readiness_dir}" ] && [ ! -L "${readiness_dir}" ]; then
    ln -s "${bundled_dir}" "${readiness_dir}"
    echo "  -> Linked ${readiness_dir} -> ${bundled_dir}"
  fi
done

# Ensure ~/.agent/skills -> ~/.agents/skills compatibility symlink
mkdir -p "${HOME}/.agent"
if [ ! -e "${HOME}/.agent/skills" ]; then
  ln -s "${HOME}/.agents/skills" "${HOME}/.agent/skills"
  echo "  -> Linked ${HOME}/.agent/skills -> ${HOME}/.agents/skills"
fi

# Symlink into detected agent skill directories
TARGET_DIRS=(
  "${HOME}/.codex/skills"
  "${HOME}/.claude/skills"
  "${HOME}/.gemini/antigravity-cli/skills"
  "${HOME}/.gemini/skills"
  "${HOME}/.gemini/config/skills"
  "${HOME}/.factory/skills"
  "${HOME}/.pi/agent/skills"
  "${HOME}/.config/opencode/skills"
  "${HOME}/.cursor/skills"
)

for dir in "${TARGET_DIRS[@]}"; do
  parent_dir="$(dirname "${dir}")"
  if [ -d "${dir}" ] || [ -d "${parent_dir}" ]; then
    mkdir -p "${dir}"
    ln -sfn "${CANONICAL_DIR}" "${dir}/${SKILL_NAME}"
    echo "  -> Linked ${dir}/${SKILL_NAME} -> ${CANONICAL_DIR}"
    for readiness_skill in "${READINESS_SKILLS[@]}"; do
      if [ ! -e "${dir}/${readiness_skill}" ] && [ ! -L "${dir}/${readiness_skill}" ]; then
        ln -s "${HOME}/.agents/skills/${readiness_skill}" "${dir}/${readiness_skill}"
        echo "  -> Linked ${dir}/${readiness_skill}"
      fi
    done
  fi
done

echo ""
echo "✅ ${SKILL_NAME} installed successfully!"
echo "   Start a mission in T3 Code with: /mission <your request>"
echo "   Resume a paused mission with:    [resume the mission]"
