//! Native Tauri renderer for normalized declarative tray snapshots.

use crate::tray_model::{TrayItem, TrayMenuSnapshot};
use std::collections::HashMap;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIcon,
    AppHandle, Runtime,
};

#[derive(Clone)]
enum NativeHandle<R: Runtime> {
    Action(MenuItem<R>),
    Check(CheckMenuItem<R>),
    Submenu(Submenu<R>),
}

impl<R: Runtime> NativeHandle<R> {
    fn update(&self, item: &TrayItem) -> Result<(), String> {
        match (self, item) {
            (Self::Action(handle), TrayItem::Action(value)) => {
                handle
                    .set_text(&value.label)
                    .map_err(|error| error.to_string())?;
                handle
                    .set_enabled(value.enabled)
                    .map_err(|error| error.to_string())
            }
            (Self::Check(handle), TrayItem::Check(value) | TrayItem::Radio(value)) => {
                handle
                    .set_text(&value.label)
                    .map_err(|error| error.to_string())?;
                handle
                    .set_enabled(value.enabled)
                    .map_err(|error| error.to_string())?;
                handle
                    .set_checked(value.checked)
                    .map_err(|error| error.to_string())
            }
            (Self::Submenu(handle), TrayItem::Submenu(value)) => {
                handle
                    .set_text(&value.label)
                    .map_err(|error| error.to_string())?;
                handle
                    .set_enabled(value.enabled)
                    .map_err(|error| error.to_string())
            }
            _ => Err("tray handle kind changed without rebuild".into()),
        }
    }
}

struct RenderedMenu<R: Runtime> {
    menu: Menu<R>,
    handles: HashMap<String, NativeHandle<R>>,
    snapshot: TrayMenuSnapshot,
}

/// Owns the native tray menu and its stable-id handle registry.
pub struct TrayRenderer<R: Runtime> {
    tray: TrayIcon<R>,
    rendered: Option<RenderedMenu<R>>,
}

impl<R: Runtime> TrayRenderer<R> {
    pub fn new(tray: TrayIcon<R>) -> Self {
        Self {
            tray,
            rendered: None,
        }
    }

    /// Apply a validated snapshot. Property-only updates retain native handles;
    /// structural updates build a complete replacement before swapping it in.
    pub fn apply(&mut self, snapshot: TrayMenuSnapshot) -> Result<(), String> {
        let snapshot = snapshot.normalize()?;
        if let Some(rendered) = &mut self.rendered {
            if same_structure(&rendered.snapshot, &snapshot) {
                update_items(&snapshot, &rendered.handles)?;
                rendered.snapshot = snapshot;
                return Ok(());
            }
        }

        let replacement = build_menu(self.tray.app_handle(), snapshot)?;
        self.tray
            .set_menu(Some(replacement.menu.clone()))
            .map_err(|error| error.to_string())?;
        self.rendered = Some(replacement);
        Ok(())
    }

    pub fn action(&self, id: &str) -> Option<crate::tray_model::TrayAction> {
        self.rendered
            .as_ref()
            .and_then(|rendered| find_action(&rendered.snapshot, id))
            .cloned()
    }
}

fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    snapshot: TrayMenuSnapshot,
) -> Result<RenderedMenu<R>, String> {
    let menu = Menu::new(app).map_err(|error| error.to_string())?;
    let mut handles = HashMap::new();
    for (group_index, group) in snapshot.groups.iter().enumerate() {
        if group_index > 0 {
            let separator =
                PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
            menu.append(&separator).map_err(|error| error.to_string())?;
        }
        append_items_to_menu(app, &menu, &group.items, &mut handles)?;
    }
    Ok(RenderedMenu {
        menu,
        handles,
        snapshot,
    })
}

fn append_items_to_menu<R: Runtime>(
    app: &AppHandle<R>,
    parent: &Menu<R>,
    items: &[TrayItem],
    handles: &mut HashMap<String, NativeHandle<R>>,
) -> Result<(), String> {
    for item in items {
        let native = build_native_item(app, item, handles)?;
        parent.append(&native).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn append_items_to_submenu<R: Runtime>(
    app: &AppHandle<R>,
    parent: &Submenu<R>,
    items: &[TrayItem],
    handles: &mut HashMap<String, NativeHandle<R>>,
) -> Result<(), String> {
    for item in items {
        let native = build_native_item(app, item, handles)?;
        parent.append(&native).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn build_native_item<R: Runtime>(
    app: &AppHandle<R>,
    item: &TrayItem,
    handles: &mut HashMap<String, NativeHandle<R>>,
) -> Result<tauri::menu::MenuItemKind<R>, String> {
    match item {
        TrayItem::Separator(_) => PredefinedMenuItem::separator(app)
            .map(tauri::menu::MenuItemKind::Predefined)
            .map_err(|error| error.to_string()),
        TrayItem::Action(value) => {
            let handle =
                MenuItem::with_id(app, &value.id, &value.label, value.enabled, None::<&str>)
                    .map_err(|error| error.to_string())?;
            handles.insert(value.id.clone(), NativeHandle::Action(handle.clone()));
            Ok(tauri::menu::MenuItemKind::MenuItem(handle))
        }
        TrayItem::Check(value) | TrayItem::Radio(value) => {
            let handle = CheckMenuItem::with_id(
                app,
                &value.id,
                &value.label,
                value.enabled,
                value.checked,
                None::<&str>,
            )
            .map_err(|error| error.to_string())?;
            handles.insert(value.id.clone(), NativeHandle::Check(handle.clone()));
            Ok(tauri::menu::MenuItemKind::Check(handle))
        }
        TrayItem::Submenu(value) => {
            let handle = Submenu::with_id(app, &value.id, &value.label, value.enabled)
                .map_err(|error| error.to_string())?;
            append_items_to_submenu(app, &handle, &value.items, handles)?;
            handles.insert(value.id.clone(), NativeHandle::Submenu(handle.clone()));
            Ok(tauri::menu::MenuItemKind::Submenu(handle))
        }
    }
}

fn update_items<R: Runtime>(
    snapshot: &TrayMenuSnapshot,
    handles: &HashMap<String, NativeHandle<R>>,
) -> Result<(), String> {
    fn visit<R: Runtime>(
        items: &[TrayItem],
        handles: &HashMap<String, NativeHandle<R>>,
    ) -> Result<(), String> {
        for item in items {
            if let Some(handle) = handles.get(item_id(item)) {
                handle.update(item)?;
            }
            if let TrayItem::Submenu(value) = item {
                visit(&value.items, handles)?;
            }
        }
        Ok(())
    }
    for group in &snapshot.groups {
        visit(&group.items, handles)?;
    }
    Ok(())
}

fn same_structure(left: &TrayMenuSnapshot, right: &TrayMenuSnapshot) -> bool {
    fn same_items(left: &[TrayItem], right: &[TrayItem]) -> bool {
        left.len() == right.len()
            && left.iter().zip(right).all(|(a, b)| {
                item_id(a) == item_id(b)
                    && item_kind(a) == item_kind(b)
                    && item_order(a) == item_order(b)
                    && item_visible(a) == item_visible(b)
                    && match (a, b) {
                        (TrayItem::Submenu(a), TrayItem::Submenu(b)) => {
                            same_items(&a.items, &b.items)
                        }
                        _ => true,
                    }
            })
    }
    left.groups.len() == right.groups.len()
        && left.groups.iter().zip(&right.groups).all(|(a, b)| {
            a.id == b.id
                && a.order == b.order
                && a.source == b.source
                && a.visible == b.visible
                && same_items(&a.items, &b.items)
        })
}

fn find_action<'a>(
    snapshot: &'a TrayMenuSnapshot,
    id: &str,
) -> Option<&'a crate::tray_model::TrayAction> {
    fn visit<'a>(items: &'a [TrayItem], id: &str) -> Option<&'a crate::tray_model::TrayAction> {
        for item in items {
            match item {
                TrayItem::Action(value) if value.id == id => return Some(&value.action),
                TrayItem::Check(value) | TrayItem::Radio(value) if value.id == id => {
                    return Some(&value.action)
                }
                TrayItem::Submenu(value) => {
                    if let Some(action) = visit(&value.items, id) {
                        return Some(action);
                    }
                }
                _ => {}
            }
        }
        None
    }
    snapshot
        .groups
        .iter()
        .find_map(|group| visit(&group.items, id))
}

fn item_id(item: &TrayItem) -> &str {
    match item {
        TrayItem::Action(v) => &v.id,
        TrayItem::Check(v) | TrayItem::Radio(v) => &v.id,
        TrayItem::Submenu(v) => &v.id,
        TrayItem::Separator(v) => &v.id,
    }
}
fn item_order(item: &TrayItem) -> i32 {
    match item {
        TrayItem::Action(v) => v.order,
        TrayItem::Check(v) | TrayItem::Radio(v) => v.order,
        TrayItem::Submenu(v) => v.order,
        TrayItem::Separator(v) => v.order,
    }
}
fn item_visible(item: &TrayItem) -> bool {
    match item {
        TrayItem::Action(v) => v.visible,
        TrayItem::Check(v) | TrayItem::Radio(v) => v.visible,
        TrayItem::Submenu(v) => v.visible,
        TrayItem::Separator(v) => v.visible,
    }
}
fn item_kind(item: &TrayItem) -> u8 {
    match item {
        TrayItem::Action(_) => 0,
        TrayItem::Check(_) => 1,
        TrayItem::Radio(_) => 2,
        TrayItem::Submenu(_) => 3,
        TrayItem::Separator(_) => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::{find_action, same_structure};
    use crate::tray_model::*;

    fn core_action_item(id: &str, order: i32) -> TrayItem {
        TrayItem::Action(TrayActionItem {
            id: id.into(),
            order,
            label: id.into(),
            enabled: true,
            visible: true,
            action: TrayAction {
                target: TrayActionTarget::Core,
                command: "window.show".into(),
                args: vec![],
                danger: TrayDanger::Safe,
                confirm: false,
            },
        })
    }

    fn check_item(id: &str, order: i32, checked: bool) -> TrayItem {
        TrayItem::Check(TrayStateItem {
            id: id.into(),
            order,
            label: id.into(),
            enabled: true,
            visible: true,
            checked,
            radio_group: None,
            action: TrayAction {
                target: TrayActionTarget::Core,
                command: "window.show".into(),
                args: vec![],
                danger: TrayDanger::Safe,
                confirm: false,
            },
        })
    }

    fn radio_item(id: &str, order: i32, checked: bool) -> TrayItem {
        let TrayItem::Check(v) = check_item(id, order, checked) else {
            unreachable!()
        };
        TrayItem::Radio(TrayStateItem {
            radio_group: Some("group".into()),
            ..v
        })
    }

    fn submenu(id: &str, order: i32, items: Vec<TrayItem>) -> TrayItem {
        TrayItem::Submenu(TraySubmenuItem {
            id: id.into(),
            order,
            label: id.into(),
            enabled: true,
            visible: true,
            items,
        })
    }

    fn separator(id: &str, order: i32) -> TrayItem {
        TrayItem::Separator(TraySeparator {
            id: id.into(),
            order,
            visible: true,
        })
    }

    fn group(id: &str, order: i32, items: Vec<TrayItem>) -> TrayGroup {
        TrayGroup {
            id: id.into(),
            order,
            label: None,
            visible: true,
            source: TraySource::Core,
            items,
        }
    }

    fn snap(groups: Vec<TrayGroup>) -> TrayMenuSnapshot {
        TrayMenuSnapshot {
            schema_version: 1,
            generation: 1,
            revision: 1,
            groups,
        }
    }

    /// A single-check-item core snapshot with a stable item id.
    fn check_snap(label: &str, checked: bool) -> TrayMenuSnapshot {
        let mut snapshot = snap(vec![group(
            "core.test",
            0,
            vec![check_item("core.test.check", 0, checked)],
        )]);
        if let TrayItem::Check(v) = &mut snapshot.groups[0].items[0] {
            v.label = label.into();
        }
        snapshot
    }

    #[test]
    fn property_changes_patch_but_order_changes_rebuild() {
        let first = check_snap("First", false);
        let mut property = check_snap("Second", true);
        // label/checked are properties → patchable.
        assert!(same_structure(&first, &property));
        // order participates in structure → rebuild.
        if let TrayItem::Check(v) = &mut property.groups[0].items[0] {
            v.order = 2;
        }
        assert!(!same_structure(&first, &property));
    }

    #[test]
    fn label_enabled_checked_are_patchable_properties() {
        let base = check_snap("Base", false);
        assert!(same_structure(&base, &check_snap("Relabeled", false)));
        assert!(same_structure(&base, &check_snap("Base", true)));
        let mut disabled = check_snap("Base", false);
        if let TrayItem::Check(v) = &mut disabled.groups[0].items[0] {
            v.enabled = false;
        }
        assert!(same_structure(&base, &disabled));
    }

    #[test]
    fn structure_changes_force_rebuild() {
        let left = snap(vec![group("g", 0, vec![core_action_item("a", 0)])]);

        // Same id, different kind.
        let kind = snap(vec![group("g", 0, vec![check_item("a", 0, false)])]);
        assert!(!same_structure(&left, &kind));

        // Same id/kind, different visibility.
        let mut hidden = left.clone();
        if let TrayItem::Action(v) = &mut hidden.groups[0].items[0] {
            v.visible = false;
        }
        assert!(!same_structure(&left, &hidden));

        // Group identity/order/source changes.
        assert!(!same_structure(
            &left,
            &snap(vec![group("other", 0, vec![core_action_item("a", 0)])])
        ));
        assert!(!same_structure(
            &left,
            &snap(vec![group("g", 1, vec![core_action_item("a", 0)])])
        ));
        let mut host_source = left.clone();
        host_source.groups[0].source = TraySource::Host;
        assert!(!same_structure(&left, &host_source));

        // Item count / membership changes.
        assert!(!same_structure(
            &left,
            &snap(vec![group(
                "g",
                0,
                vec![core_action_item("a", 0), core_action_item("b", 1)]
            )])
        ));
        assert!(!same_structure(
            &left,
            &snap(vec![group("g", 0, vec![core_action_item("b", 0)])])
        ));
    }

    #[test]
    fn structure_recursion_covers_submenu_children() {
        let nested = |items: Vec<TrayItem>| vec![submenu("sub", 0, items)];
        let left = snap(vec![group("g", 0, nested(vec![core_action_item("a", 0)]))]);

        // Child label is a property change.
        let mut relabeled = snap(vec![group("g", 0, nested(vec![core_action_item("a", 0)]))]);
        if let TrayItem::Action(v) = &mut relabeled.groups[0].items[0] {
            v.label = "renamed".into();
        }
        assert!(same_structure(&left, &relabeled));

        // Child order, kind, removal, and submenu id all force rebuild.
        assert!(!same_structure(
            &left,
            &snap(vec![group("g", 0, nested(vec![core_action_item("a", 1)]))])
        ));
        assert!(!same_structure(
            &left,
            &snap(vec![group("g", 0, nested(vec![check_item("a", 0, false)]))])
        ));
        assert!(!same_structure(
            &left,
            &snap(vec![group("g", 0, vec![core_action_item("other", 9)])])
        ));
        assert!(!same_structure(
            &left,
            &snap(vec![group(
                "g",
                0,
                vec![submenu("renamed-sub", 0, vec![core_action_item("a", 0)])]
            )])
        ));
    }

    #[test]
    fn find_action_walks_groups_submenus_and_state_items() {
        let snapshot = snap(vec![group(
            "core.controls",
            0,
            vec![
                core_action_item("core.window.show", 0),
                submenu(
                    "core.developer",
                    10,
                    vec![core_action_item("core.devtools.open", 0)],
                ),
                check_item("core.option.check", 20, true),
                radio_item("core.option.radio", 30, false),
                separator("sep", 40),
            ],
        )]);
        assert_eq!(
            find_action(&snapshot, "core.window.show").unwrap().command,
            "window.show"
        );
        assert_eq!(
            find_action(&snapshot, "core.devtools.open").unwrap().target,
            TrayActionTarget::Core
        );
        assert_eq!(
            find_action(&snapshot, "core.option.check").unwrap().target,
            TrayActionTarget::Core
        );
        assert_eq!(
            find_action(&snapshot, "core.option.radio").unwrap().target,
            TrayActionTarget::Core
        );
        // Separators and unknown ids carry no action.
        assert!(find_action(&snapshot, "sep").is_none());
        assert!(find_action(&snapshot, "missing").is_none());
    }

    #[test]
    fn item_helpers_pin_kind_ids_orders_and_visibility() {
        use super::{item_id, item_kind, item_order, item_visible};
        let items = [
            core_action_item("a", 0),
            check_item("b", 1, false),
            radio_item("c", 2, false),
            submenu("d", 3, vec![]),
            separator("e", 4),
        ];
        let kinds: Vec<u8> = items.iter().map(item_kind).collect();
        assert_eq!(kinds, vec![0, 1, 2, 3, 4]);
        let ids: Vec<&str> = items.iter().map(item_id).collect();
        assert_eq!(ids, vec!["a", "b", "c", "d", "e"]);
        let orders: Vec<i32> = items.iter().map(item_order).collect();
        assert_eq!(orders, vec![0, 1, 2, 3, 4]);
        assert!(items.iter().all(|i| item_visible(i)));
    }
}
