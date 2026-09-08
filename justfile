set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

root_dir := justfile_directory()
# Show available commands
default:
    @just --list

setup-encoding_rs_io:
    @just --justfile "{{justfile()}}" setup-target \
        "src-tauri/ext/encoding_rs_io" \
        "src-tauri/ext/encoding_rs_io" \
        "04268d951494a90649f35088253e549fade32f44" \
        "https://github.com/BurntSushi/encoding_rs_io.git" \
        "src-tauri/patches/encoding_rs_io_0.1.8.patch" \
        ""

setup-target clone_dir target_dir repo_rev repo_url target_patch sparse_dirs:
    mkdir -p "{{root_dir}}/ext"
    git config --global core.autocrlf false
    if [ ! -d "{{root_dir}}/{{clone_dir}}/.git" ]; then \
      git clone --depth 1 --filter=blob:none --no-checkout "{{repo_url}}" "{{root_dir}}/{{clone_dir}}"; \
    else \
      echo "{{clone_dir}} already exists; skipping clone"; \
    fi
    cd "{{root_dir}}/{{clone_dir}}" && git fetch --depth 1 origin "{{repo_rev}}"
    if [ -n "{{sparse_dirs}}" ]; then \
      cd "{{root_dir}}/{{clone_dir}}" && git sparse-checkout init --cone; \
      cd "{{root_dir}}/{{clone_dir}}" && git sparse-checkout set {{sparse_dirs}}; \
    fi
    cd "{{root_dir}}/{{clone_dir}}" && git checkout --detach FETCH_HEAD
    test -d "{{root_dir}}/{{target_dir}}"
    cd "{{root_dir}}/{{target_dir}}" && git apply --check "{{root_dir}}/{{target_patch}}"
    cd "{{root_dir}}/{{target_dir}}" && git apply "{{root_dir}}/{{target_patch}}"

reset-target clone_dir target_dir repo_rev target_patch:
    test -d "{{root_dir}}/{{clone_dir}}/.git"
    cd "{{root_dir}}/{{clone_dir}}" && git fetch --depth 1 origin "{{repo_rev}}"
    cd "{{root_dir}}/{{clone_dir}}" && git reset --hard FETCH_HEAD
    cd "{{root_dir}}/{{clone_dir}}" && git clean -fd
    cd "{{root_dir}}/{{target_dir}}" && git apply --check "{{root_dir}}/{{target_patch}}"
    cd "{{root_dir}}/{{target_dir}}" && git apply "{{root_dir}}/{{target_patch}}"

setup-ext: setup-encoding_rs_io