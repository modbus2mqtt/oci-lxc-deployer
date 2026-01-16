#!/usr/bin/env python3
"""Replace variants of 'LXC Manager' with 'OCI LXC Deployer'.

Replaces occurrences in file contents and renames files/directories.
Skips binary files and respects .gitignore entries and common exclude dirs.

Usage: python3 scripts/replace_lxc_manager.py /path/to/repo
Options: --dry-run to only show planned changes
"""
import os
import re
import fnmatch
import argparse
import json
from datetime import datetime


DEFAULT_EXCLUDE_DIRS = {'.git', 'node_modules', 'dist', 'build', '__pycache__', '.venv', 'venv'}
# files that must never be modified by this script
DEFAULT_EXCLUDE_FILES = {'replace_lxc_manager.py', 'find_lxc_manager.py'}


def load_gitignore_patterns(root):
    gitignore = os.path.join(root, '.gitignore')
    patterns = []
    if not os.path.exists(gitignore):
        return patterns
    try:
        with open(gitignore, 'r', encoding='utf-8', errors='ignore') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if line.startswith('!'):
                    continue
                if line.endswith('/'):
                    line = line.rstrip('/')
                patterns.append(line)
    except Exception:
        return []
    return patterns


def matches_gitignore(relpath, name, gitignore_patterns):
    for pat in gitignore_patterns:
        if '/' in pat:
            if relpath == pat or relpath.startswith(pat + '/'):
                return True
            if fnmatch.fnmatch(relpath, pat):
                return True
        else:
            if fnmatch.fnmatch(name, pat) or fnmatch.fnmatch(relpath, pat):
                return True
    return False


def is_binary_file(path):
    try:
        with open(path, 'rb') as f:
            chunk = f.read(1024)
            return b'\0' in chunk
    except Exception:
        return True


def make_replacer():
    # make content replacement case-insensitive so variants like
    # 'Lxc Manager' or 'LXC MANAGER' are matched as well
    pattern = re.compile(r'(?<!\w)(lxc[\s._\-]?manager|oci-lxc-deployer)(?!\w)', re.IGNORECASE)

    def replacement_for(token: str) -> str:
        # token may have mixed case; inspect separators
        if '-' in token:
            return 'oci-lxc-deployer'
        if '_' in token:
            return 'oci_lxc_deployer'
        if ' ' in token:
            # human readable form
            return 'OCI LXC Deployer'
        # camelCase or PascalCase detection
        if any(c.isupper() for c in token[1:]):
            # CamelCase or mixed
            if token[0].islower():
                return 'ociLxcDeployer'
            else:
                return 'OciLxcDeployer'
        # fallback: use hyphenated lowercase
        return 'oci-lxc-deployer'

    def repl(m):
        token = m.group(0)
        # If the original is ALL CAPS, return an uppercase replacement
        if token.isupper():
            return replacement_for(token).upper()
        # otherwise return canonical replacement (which preserves separators)
        return replacement_for(token)

    return pattern, repl


def replace_in_files(root, excludes, gitignore_patterns, dry_run=False):
    pattern, repl = make_replacer()
    changes = {'files': [], 'file_renames': [], 'dir_renames': []}
    root = os.path.abspath(root)

    for dirpath, dirnames, filenames in os.walk(root):
        # filter dirs
        kept = []
        for d in dirnames:
            rel = os.path.normpath(os.path.relpath(os.path.join(dirpath, d), root)).replace('\\', '/')
            if any(fnmatch.fnmatch(d, pat) for pat in excludes):
                continue
            if matches_gitignore(rel, d, gitignore_patterns):
                continue
            kept.append(d)
        dirnames[:] = kept

        for fname in filenames:
            fpath = os.path.join(dirpath, fname)
            rel = os.path.normpath(os.path.relpath(fpath, root)).replace('\\', '/')
            # never touch these script files
            if fname in DEFAULT_EXCLUDE_FILES:
                continue
            if matches_gitignore(rel, fname, gitignore_patterns):
                continue
            if is_binary_file(fpath):
                continue
            try:
                with open(fpath, 'r', encoding='utf-8', errors='ignore') as f:
                    text = f.read()
            except Exception:
                continue

            new_text = pattern.sub(repl, text)
            if new_text != text:
                changes['files'].append(fpath)
                if not dry_run:
                    # backup original
                    try:
                        with open(fpath + '.bak', 'w', encoding='utf-8') as b:
                            b.write(text)
                    except Exception:
                        pass
                    try:
                        with open(fpath, 'w', encoding='utf-8') as f:
                            f.write(new_text)
                    except Exception:
                        print('Failed to write', fpath)

    return changes


def rename_paths(root, excludes, gitignore_patterns, dry_run=False):
    # rename files and directories bottom-up
    changes = {'file_renames': [], 'dir_renames': []}
    root = os.path.abspath(root)
    pattern = re.compile(r'(?<!\w)(lxc[\s._\-]?manager|oci-lxc-deployer)(?!\w)', re.IGNORECASE)

    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        # files first
        for fname in filenames:
            # do not rename the controlling scripts
            if fname in DEFAULT_EXCLUDE_FILES:
                continue
            if is_binary_file(os.path.join(dirpath, fname)):
                continue
            if pattern.search(fname):
                new_name = pattern.sub('oci-lxc-deployer', fname)
                src = os.path.join(dirpath, fname)
                dst = os.path.join(dirpath, new_name)
                changes['file_renames'].append((src, dst))
                if not dry_run:
                    try:
                        os.rename(src, dst)
                    except Exception as e:
                        print('Rename failed', src, '->', dst, e)

        # directories
        for d in dirnames:
            if pattern.search(d):
                new_name = pattern.sub('oci-lxc-deployer', d)
                src = os.path.join(dirpath, d)
                dst = os.path.join(dirpath, new_name)
                changes['dir_renames'].append((src, dst))
                if not dry_run:
                    try:
                        os.rename(src, dst)
                    except Exception as e:
                        print('Dir rename failed', src, '->', dst, e)

    return changes


def main():
    parser = argparse.ArgumentParser(description='Replace LXC Manager variants with OCI LXC Deployer')
    parser.add_argument('root', nargs='?', default='.', help='Repository root')
    parser.add_argument('--dry-run', action='store_true', help='Do not modify files, only show planned changes')
    args = parser.parse_args()

    excludes = set(DEFAULT_EXCLUDE_DIRS)
    gitignore_patterns = load_gitignore_patterns(args.root)

    print('Scanning and replacing in files...')
    file_changes = replace_in_files(args.root, excludes, gitignore_patterns, dry_run=args.dry_run)

    print('Renaming files and directories...')
    rename_changes = rename_paths(args.root, excludes, gitignore_patterns, dry_run=args.dry_run)

    manifest = {
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'root': os.path.abspath(args.root),
        'dry_run': args.dry_run,
        'file_changes': file_changes.get('files', []),
        'file_renames': rename_changes.get('file_renames', []),
        'dir_renames': rename_changes.get('dir_renames', []),
    }

    manifest_path = os.path.join(args.root, 'scripts', 'replace_lxc_manager_changes.json')
    try:
        with open(manifest_path, 'w', encoding='utf-8') as mf:
            json.dump(manifest, mf, indent=2)
    except Exception:
        print('Failed to write manifest')

    print('\nSummary:')
    print(f"Files modified: {len(manifest['file_changes'])}")
    print(f"Files renamed: {len(manifest['file_renames'])}")
    print(f"Dirs renamed: {len(manifest['dir_renames'])}")
    print(f"Manifest written to: {manifest_path}")


if __name__ == '__main__':
    main()
