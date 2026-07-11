/*!
 * PatentLens Tauri 主入口
 * Copyright (c) 2026 Alfred Shi. All rights reserved.
 * 本软件仅供内部使用，未经授权不得对外传播、复制或分发。
 * @author Alfred Shi
 * @version 260710
 */
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// __PATENTLENS_COPYRIGHT__: Alfred Shi 2026

fn main() {
  app_lib::run();
}
