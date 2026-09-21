#!/usr/bin/env bash
# File: worktree-setup (put in PATH or current repo)

case "$1" in
  spawn)
    branch="$2" base="${3:-dev}"
    git worktree add -b "$branch" "../worktrees/$branch" "$base"
    cp .env "../worktrees/$branch/.env" 2>/dev/null || touch "../worktrees/$branch/.env"
    cp .dev.vars "../worktrees/$branch/.dev.vars" 2>/dev/null || touch "../worktrees/$branch/.dev.vars"
    ;;
  kill)
    git worktree remove --force "../worktrees/$2" && git worktree prune
    ;;
  *)
    echo "Usage: $0 {spawn <branch> [base]|kill <branch>}"
    exit 1
    ;;
esac