//! Project-level declarative tray menu domain model.
//! Native Tauri menu objects are rendered elsewhere; this module is transport-safe,
//! deterministic, and contains no host lifecycle types or OS handles.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

const MAX_GROUPS: usize = 64;
const MAX_ITEMS: usize = 512;
const MAX_DEPTH: usize = 8;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrayMenuSnapshot {
    pub schema_version: u16,
    pub generation: u64,
    pub revision: u64,
    pub groups: Vec<TrayGroup>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrayGroup {
    pub id: String,
    pub order: i32,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default = "default_true")]
    pub visible: bool,
    /// Ownership discriminator and the wire-level privilege boundary.
    ///
    /// Required on purpose (the JSON Schema marks it required and Rust is the
    /// enforcement point): defaulting a missing `source` to `Core` would let a
    /// host/plugin payload claim core ownership and thereby reach the
    /// `target=app` commands. `TraySource` has no `#[serde(default)]` here.
    pub source: TraySource,
    #[serde(default)]
    pub items: Vec<TrayItem>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TraySource {
    #[default]
    Core,
    Host,
    Plugin,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TrayItem {
    Action(TrayActionItem),
    Check(TrayStateItem),
    Radio(TrayStateItem),
    Submenu(TraySubmenuItem),
    Separator(TraySeparator),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrayActionItem {
    pub id: String,
    pub order: i32,
    pub label: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub visible: bool,
    pub action: TrayAction,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrayStateItem {
    pub id: String,
    pub order: i32,
    pub label: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub visible: bool,
    #[serde(default)]
    pub checked: bool,
    #[serde(default)]
    pub radio_group: Option<String>,
    pub action: TrayAction,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TraySubmenuItem {
    pub id: String,
    pub order: i32,
    pub label: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub visible: bool,
    #[serde(default)]
    pub items: Vec<TrayItem>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TraySeparator {
    pub id: String,
    pub order: i32,
    #[serde(default = "default_true")]
    pub visible: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrayAction {
    pub target: TrayActionTarget,
    pub command: String,
    #[serde(default)]
    pub args: Vec<Value>,
    #[serde(default)]
    pub danger: TrayDanger,
    #[serde(default)]
    pub confirm: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TrayActionTarget {
    #[default]
    Host,
    Core,
    App,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum TrayDanger {
    #[default]
    Safe,
    Stateful,
    Disruptive,
    Destructive,
}

fn default_true() -> bool {
    true
}

impl TrayMenuSnapshot {
    /// Validate and return a deterministic native-renderer input.
    pub fn normalize(mut self) -> Result<Self, String> {
        if self.schema_version != 1 {
            return Err(format!(
                "unsupported schema_version: {} (expected 1)",
                self.schema_version
            ));
        }
        if self.generation > MAX_SAFE_INTEGER || self.revision > MAX_SAFE_INTEGER {
            return Err("generation and revision must be safe integers".into());
        }
        if self.groups.len() > MAX_GROUPS {
            return Err("too many groups".into());
        }
        let mut ids = HashSet::new();
        let mut total = 0;
        // Radio exclusivity is a snapshot-wide rule: a radio_group must have at
        // most one checked item no matter which group/submenu holds it.
        let mut radios: HashMap<String, usize> = HashMap::new();
        for group in &mut self.groups {
            validate_id(&group.id)?;
            if !ids.insert(group.id.clone()) {
                return Err(format!("duplicate id: {}", group.id));
            }
            if group.source != TraySource::Core && group.id.starts_with("core.") {
                return Err("non-core group cannot use core.* id".into());
            }
            if let Some(label) = &group.label {
                // The contract allows an empty group label (`string|null`,
                // no minLength); treat it as "unlabelled" instead of
                // rejecting a schema-valid payload.
                if !label.is_empty() {
                    validate_label(label)?;
                }
            }
            total += validate_items(
                &mut group.items,
                1,
                &mut ids,
                &mut radios,
                group.source == TraySource::Core,
            )?;
        }
        if total > MAX_ITEMS {
            return Err("too many items".into());
        }
        if radios.values().any(|checked| *checked > 1) {
            return Err("radio group has multiple checked items".into());
        }
        for g in &mut self.groups {
            g.items = normalize_items(std::mem::take(&mut g.items));
        }
        self.groups.retain(|g| g.visible && !g.items.is_empty());
        self.groups
            .sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
        Ok(self)
    }
}

fn validate_items(
    items: &mut [TrayItem],
    depth: usize,
    ids: &mut HashSet<String>,
    radios: &mut HashMap<String, usize>,
    core_owned: bool,
) -> Result<usize, String> {
    if depth > MAX_DEPTH {
        return Err("submenu nesting too deep".into());
    }
    let mut count = 0;
    for item in items {
        count += 1;
        let (id, _order, visible) = item_meta(item);
        let id = id.to_owned();
        let visible = *visible;
        validate_id(&id)?;
        if !ids.insert(id.clone()) {
            return Err(format!("duplicate id: {id}"));
        }
        match item {
            TrayItem::Action(v) => {
                validate_label(&v.label)?;
                validate_action(&v.action, core_owned)?;
            }
            TrayItem::Check(v) => {
                validate_label(&v.label)?;
                validate_action(&v.action, core_owned)?;
                if v.radio_group.is_some() {
                    return Err("check item cannot have radio_group".into());
                }
            }
            TrayItem::Radio(v) => {
                validate_label(&v.label)?;
                validate_action(&v.action, core_owned)?;
                let g = v
                    .radio_group
                    .as_ref()
                    .ok_or("radio item requires radio_group")?;
                validate_id(g)?;
                *radios.entry(g.clone()).or_default() += usize::from(v.checked && visible);
            }
            TrayItem::Submenu(v) => {
                validate_label(&v.label)?;
                count += validate_items(&mut v.items, depth + 1, ids, radios, core_owned)?;
            }
            TrayItem::Separator(_) => {}
        }
    }
    Ok(count)
}

fn validate_action(action: &TrayAction, core_owned: bool) -> Result<(), String> {
    if (!core_owned && action.target != TrayActionTarget::Host)
        || (core_owned && action.target == TrayActionTarget::Host)
    {
        return Err("action target is not allowed for group source".into());
    }
    if action.command.is_empty()
        || action.command.len() > 128
        || !action
            .command
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c))
    {
        return Err("invalid action command".into());
    }
    if action.args.len() > 16 {
        return Err("too many action arguments".into());
    }
    // Only host-owned actions can carry args: core/app commands are a fixed
    // Rust-side allowlist and take no parameters, so silently ignoring args on
    // them would hide a contract mistake.
    if action.target != TrayActionTarget::Host && !action.args.is_empty() {
        return Err("only host actions may carry args".into());
    }
    Ok(())
}
fn validate_label(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 256 {
        Err("invalid label".into())
    } else {
        Ok(())
    }
}
fn validate_id(s: &str) -> Result<(), String> {
    if s.is_empty()
        || s.len() > 128
        || !s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c))
    {
        Err(format!("invalid id: {s}"))
    } else {
        Ok(())
    }
}
fn item_meta(item: &TrayItem) -> (&str, &i32, &bool) {
    match item {
        TrayItem::Action(v) => (&v.id, &v.order, &v.visible),
        TrayItem::Check(v) | TrayItem::Radio(v) => (&v.id, &v.order, &v.visible),
        TrayItem::Submenu(v) => (&v.id, &v.order, &v.visible),
        TrayItem::Separator(v) => (&v.id, &v.order, &v.visible),
    }
}
fn item_visible(item: &TrayItem) -> bool {
    *item_meta(item).2
}
fn normalize_items(mut items: Vec<TrayItem>) -> Vec<TrayItem> {
    for item in &mut items {
        if let TrayItem::Submenu(submenu) = item {
            submenu.items = normalize_items(std::mem::take(&mut submenu.items));
        }
    }
    items.retain(|item| {
        item_visible(item)
            && !matches!(item, TrayItem::Submenu(submenu) if submenu.items.is_empty())
    });
    items.sort_by(|a, b| {
        item_meta(a)
            .1
            .cmp(item_meta(b).1)
            .then_with(|| item_meta(a).0.cmp(item_meta(b).0))
    });
    while matches!(items.first(), Some(TrayItem::Separator(_))) {
        items.remove(0);
    }
    while matches!(items.last(), Some(TrayItem::Separator(_))) {
        items.pop();
    }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        if matches!(out.last(), Some(TrayItem::Separator(_)))
            && matches!(item, TrayItem::Separator(_))
        {
            continue;
        }
        out.push(item);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn action(id: &str, order: i32) -> TrayItem {
        TrayItem::Action(TrayActionItem {
            id: id.into(),
            order,
            label: id.into(),
            enabled: true,
            visible: true,
            action: TrayAction {
                target: TrayActionTarget::Host,
                command: "do.work".into(),
                args: vec![],
                danger: TrayDanger::Safe,
                confirm: false,
            },
        })
    }
    fn group(id: &str, order: i32, items: Vec<TrayItem>) -> TrayGroup {
        TrayGroup {
            id: id.into(),
            order,
            label: None,
            visible: true,
            source: TraySource::Host,
            items,
        }
    }
    fn snap(groups: Vec<TrayGroup>) -> TrayMenuSnapshot {
        TrayMenuSnapshot {
            schema_version: 1,
            generation: 2,
            revision: 3,
            groups,
        }
    }
    #[test]
    fn sorts_groups_and_items_by_order_then_id() {
        let n = snap(vec![
            group("group-b", 2, vec![action("item-z", 1), action("item-a", 1)]),
            group("group-a", 1, vec![action("item-x", 1)]),
        ])
        .normalize()
        .unwrap();
        assert_eq!(n.groups[0].id, "group-a");
        assert_eq!(item_meta(&n.groups[1].items[0]).0, "item-a");
    }
    #[test]
    fn rejects_duplicate_ids_and_invalid_ids() {
        assert!(
            snap(vec![group("g", 0, vec![action("x", 0), action("x", 1)])])
                .normalize()
                .is_err()
        );
        assert!(snap(vec![group("bad id", 0, vec![])]).normalize().is_err());
    }
    #[test]
    fn rejects_unsupported_schema_version() {
        let mut snapshot = snap(vec![]);
        snapshot.schema_version = 2;
        assert_eq!(
            snapshot.normalize().unwrap_err(),
            "unsupported schema_version: 2 (expected 1)"
        );
    }
    #[test]
    fn rejects_generation_or_revision_beyond_safe_integer() {
        let mut snapshot = snap(vec![]);
        snapshot.generation = MAX_SAFE_INTEGER + 1;
        assert!(snapshot.clone().normalize().is_err());
        snapshot.generation = 0;
        snapshot.revision = MAX_SAFE_INTEGER + 1;
        assert!(snapshot.normalize().is_err());
    }
    #[test]
    fn rejects_hidden_invalid_subtrees_and_cleans_empty_submenus() {
        let mut hidden = action("hidden.invalid", 0);
        if let TrayItem::Action(item) = &mut hidden {
            item.visible = false;
            item.action.command = "bad command".into();
        }
        assert!(snap(vec![group("host.invalid", 0, vec![hidden])])
            .normalize()
            .is_err());

        let empty = TrayItem::Submenu(TraySubmenuItem {
            id: "empty.submenu".into(),
            order: 0,
            label: "Empty".into(),
            enabled: true,
            visible: true,
            items: vec![],
        });
        let normalized = snap(vec![group("host.empty", 0, vec![empty])])
            .normalize()
            .unwrap();
        assert!(normalized.groups.is_empty());
    }

    #[test]
    fn rejects_source_target_escalation() {
        let mut host_group = group("host.group", 0, vec![action("host.action", 0)]);
        if let TrayItem::Action(item) = &mut host_group.items[0] {
            item.action.target = TrayActionTarget::Core;
        }
        assert!(snap(vec![host_group]).normalize().is_err());

        let mut core_group = group("core.window", 0, vec![action("core.window.show", 0)]);
        core_group.source = TraySource::Core;
        assert!(snap(vec![core_group.clone()]).normalize().is_err());
        if let TrayItem::Action(item) = &mut core_group.items[0] {
            item.action.target = TrayActionTarget::App;
        }
        assert!(snap(vec![core_group]).normalize().is_ok());
    }
    #[test]
    fn rejects_multiple_checked_radio_items() {
        let a = match action("a", 0) {
            TrayItem::Action(v) => v,
            _ => unreachable!(),
        };
        let mk = |id: &str| {
            TrayItem::Radio(TrayStateItem {
                id: id.into(),
                order: 0,
                label: id.into(),
                enabled: true,
                visible: true,
                checked: true,
                radio_group: Some("r".into()),
                action: a.action.clone(),
            })
        };
        assert!(snap(vec![group("g", 0, vec![mk("a"), mk("b")])])
            .normalize()
            .is_err());
    }
    #[test]
    fn strips_edge_and_duplicate_separators() {
        let mut separator = 0;
        let mut sep = || {
            separator += 1;
            TrayItem::Separator(TraySeparator {
                id: format!("separator-{separator}"),
                order: separator,
                visible: true,
            })
        };
        let n = snap(vec![group(
            "g",
            0,
            vec![sep(), action("a", 1), sep(), sep(), action("b", 2), sep()],
        )])
        .normalize()
        .unwrap();
        assert_eq!(n.groups[0].items.len(), 3);
        assert!(!matches!(n.groups[0].items[0], TrayItem::Separator(_)));
        assert!(!matches!(n.groups[0].items[2], TrayItem::Separator(_)));
    }
    #[test]
    fn invisible_items_and_groups_are_removed() {
        let mut i = action("x", 0);
        if let TrayItem::Action(v) = &mut i {
            v.visible = false;
        }
        let n = snap(vec![
            group("g", 0, vec![i]),
            group("h", 1, vec![action("y", 0)]),
        ])
        .normalize()
        .unwrap();
        assert_eq!(n.groups.len(), 1);
    }

    fn mk_action(
        id: &str,
        command: &str,
        target: TrayActionTarget,
        label: &str,
        args: Vec<Value>,
    ) -> TrayItem {
        TrayItem::Action(TrayActionItem {
            id: id.into(),
            order: 0,
            label: label.into(),
            enabled: true,
            visible: true,
            action: TrayAction {
                target,
                command: command.into(),
                args,
                danger: TrayDanger::Safe,
                confirm: false,
            },
        })
    }

    #[test]
    fn rejects_invalid_action_commands_labels_and_arg_limits() {
        // Empty command.
        assert!(snap(vec![group(
            "g",
            0,
            vec![mk_action("a", "", TrayActionTarget::Host, "a", vec![])]
        )])
        .normalize()
        .is_err());
        // Command with characters outside [A-Za-z0-9._-].
        assert!(snap(vec![group(
            "g",
            0,
            vec![mk_action(
                "a",
                "bad command",
                TrayActionTarget::Host,
                "a",
                vec![]
            )]
        )])
        .normalize()
        .is_err());
        // Command longer than 128 chars.
        let long_command = "x".repeat(129);
        assert!(snap(vec![group(
            "g",
            0,
            vec![mk_action(
                "a",
                &long_command,
                TrayActionTarget::Host,
                "a",
                vec![]
            )]
        )])
        .normalize()
        .is_err());
        // Empty label.
        assert!(snap(vec![group(
            "g",
            0,
            vec![mk_action(
                "a",
                "do.work",
                TrayActionTarget::Host,
                "",
                vec![]
            )]
        )])
        .normalize()
        .is_err());
        // Label longer than 256 chars.
        let long_label = "l".repeat(257);
        assert!(snap(vec![group(
            "g",
            0,
            vec![mk_action(
                "a",
                "do.work",
                TrayActionTarget::Host,
                &long_label,
                vec![]
            )]
        )])
        .normalize()
        .is_err());
        // More than 16 action args.
        assert!(snap(vec![group(
            "g",
            0,
            vec![mk_action(
                "a",
                "do.work",
                TrayActionTarget::Host,
                "a",
                vec![json!(1); 17]
            )]
        )])
        .normalize()
        .is_err());
        // 16 args is the boundary and is accepted.
        assert!(snap(vec![group(
            "g",
            0,
            vec![mk_action(
                "a",
                "do.work",
                TrayActionTarget::Host,
                "a",
                vec![json!(1); 16]
            )]
        )])
        .normalize()
        .is_ok());
    }

    #[test]
    fn rejects_invalid_item_ids_and_cross_group_duplicate_ids() {
        // Item id with illegal characters.
        let mut bad = action("bad id", 0);
        if let TrayItem::Action(v) = &mut bad {
            v.id = "bad id!".into();
        }
        assert!(snap(vec![group("g", 0, vec![bad])]).normalize().is_err());
        // Item id too long (>128).
        let mut long = action("x", 0);
        if let TrayItem::Action(v) = &mut long {
            v.id = "i".repeat(129);
        }
        assert!(snap(vec![group("g", 0, vec![long])]).normalize().is_err());
        // Duplicate ids across two different groups are rejected (global registry).
        assert!(snap(vec![
            group("g1", 0, vec![action("dup", 0)]),
            group("g2", 1, vec![action("dup", 0)])
        ])
        .normalize()
        .is_err());
        // Duplicate between an item and its submenu child.
        assert!(snap(vec![group(
            "g",
            0,
            vec![TrayItem::Submenu(TraySubmenuItem {
                id: "sub".into(),
                order: 0,
                label: "Sub".into(),
                enabled: true,
                visible: true,
                items: vec![action("sub", 0)],
            })]
        )])
        .normalize()
        .is_err());
    }

    #[test]
    fn rejects_excessive_groups_items_and_submenu_depth() {
        // More than MAX_GROUPS (64) groups.
        let many: Vec<TrayGroup> = (0..65)
            .map(|i| group(&format!("g{i}"), i, vec![action("x", 0)]))
            .collect();
        assert!(snap(many).normalize().is_err());
        // Item budget overflow via a single group with 513 top-level items.
        let overflow: Vec<TrayItem> = (0..513).map(|i| action(&format!("i{i}"), i)).collect();
        assert!(snap(vec![group("g", 0, overflow)]).normalize().is_err());
        // Item budget counts submenu children (500 top + 13 nested = 513).
        let nested: Vec<TrayItem> = (0..13).map(|i| action(&format!("n{i}"), i)).collect();
        let mut parent_items: Vec<TrayItem> = (0..500)
            .map(|i| action(&format!("t{i}"), i + 1000))
            .collect();
        parent_items.push(TrayItem::Submenu(TraySubmenuItem {
            id: "sub".into(),
            order: 5000,
            label: "Sub".into(),
            enabled: true,
            visible: true,
            items: nested,
        }));
        assert!(snap(vec![group("g", 0, parent_items)]).normalize().is_err());
        // Depth limit: nesting deeper than MAX_DEPTH (8) is rejected. The
        // top-level items live at depth 1 and every submenu adds one, so 8
        // nested submenus (depth 9) is over the limit while 7 is the max.
        let mut deep = action("leaf", 0);
        for level in 0..8 {
            deep = TrayItem::Submenu(TraySubmenuItem {
                id: format!("depth{level}"),
                order: 0,
                label: "Deep".into(),
                enabled: true,
                visible: true,
                items: vec![deep],
            });
        }
        assert!(snap(vec![group("g", 0, vec![deep])]).normalize().is_err());
        // Depth of exactly MAX_DEPTH (7 nested submenus) is accepted.
        let mut ok_depth = action("leaf", 0);
        for level in 0..7 {
            ok_depth = TrayItem::Submenu(TraySubmenuItem {
                id: format!("depth{level}"),
                order: 0,
                label: "Deep".into(),
                enabled: true,
                visible: true,
                items: vec![ok_depth],
            });
        }
        assert!(snap(vec![group("g", 0, vec![ok_depth])])
            .normalize()
            .is_ok());
    }

    #[test]
    fn rejects_misused_radio_grouping_and_honors_visibility() {
        let mk_radio = |id: &str, checked: bool, visible: bool, radio_group: Option<&str>| {
            TrayItem::Radio(TrayStateItem {
                id: id.into(),
                order: 0,
                label: id.into(),
                enabled: true,
                visible,
                checked,
                radio_group: radio_group.map(str::to_string),
                action: TrayAction {
                    target: TrayActionTarget::Host,
                    command: "do.work".into(),
                    args: vec![],
                    danger: TrayDanger::Safe,
                    confirm: false,
                },
            })
        };
        // Check item must not carry a radio_group.
        assert!(snap(vec![group(
            "g",
            0,
            vec![TrayItem::Check(TrayStateItem {
                id: "c".into(),
                order: 0,
                label: "C".into(),
                enabled: true,
                visible: true,
                checked: false,
                radio_group: Some("r".into()),
                action: TrayAction {
                    target: TrayActionTarget::Host,
                    command: "do.work".into(),
                    args: vec![],
                    danger: TrayDanger::Safe,
                    confirm: false,
                },
            })]
        )])
        .normalize()
        .is_err());
        // Radio item without a radio_group is rejected.
        assert!(
            snap(vec![group("g", 0, vec![mk_radio("r", false, true, None)])])
                .normalize()
                .is_err()
        );
        // Radio group id must itself be a valid id.
        assert!(snap(vec![group(
            "g",
            0,
            vec![mk_radio("r", false, true, Some("bad group!"))]
        )])
        .normalize()
        .is_err());
        // Two visible checked radios in the same group are rejected.
        assert!(snap(vec![group(
            "g",
            0,
            vec![
                mk_radio("a", true, true, Some("r")),
                mk_radio("b", true, true, Some("r"))
            ]
        )])
        .normalize()
        .is_err());
        // A hidden checked radio does not count toward exclusivity.
        assert!(snap(vec![group(
            "g",
            0,
            vec![
                mk_radio("a", true, true, Some("r")),
                mk_radio("b", true, false, Some("r"))
            ]
        )])
        .normalize()
        .is_ok());
        // Radios in distinct groups never conflict.
        assert!(snap(vec![group(
            "g",
            0,
            vec![
                mk_radio("a", true, true, Some("r1")),
                mk_radio("b", true, true, Some("r2"))
            ]
        )])
        .normalize()
        .is_ok());
    }

    #[test]
    fn group_label_and_invalid_group_ids_are_validated() {
        // A group label longer than 256 chars is rejected.
        let mut g = group("g", 0, vec![action("x", 0)]);
        g.label = Some("l".repeat(257));
        assert!(snap(vec![g]).normalize().is_err());
        // A non-core group cannot claim a core.* id.
        assert!(snap(vec![group("core.window", 0, vec![action("x", 0)])])
            .normalize()
            .is_err());
        // A core group with a host-target action is rejected.
        let mut cg = group("core.window", 0, vec![action("x", 0)]);
        cg.source = TraySource::Core;
        assert!(snap(vec![cg]).normalize().is_err());
    }

    #[test]
    fn group_source_is_required_on_the_wire() {
        // `source` is the ownership discriminator: a payload that omits it must
        // NOT silently become core-owned (that would allow target=app).
        let without_source = json!({
            "schemaVersion": 1,
            "generation": 0,
            "revision": 1,
            "groups": [{
                "id": "host.a",
                "order": 1,
                "label": null,
                "visible": true,
                "items": []
            }]
        });
        let err = serde_json::from_value::<TrayMenuSnapshot>(without_source)
            .expect_err("source is required");
        assert!(err.to_string().contains("source"), "{err}");
    }

    #[test]
    fn empty_group_label_means_unlabelled() {
        // The contract allows "" (string|null without minLength); the model
        // treats it as "no label" rather than rejecting a schema-valid payload.
        let mut g = group("g", 0, vec![action("x", 0)]);
        g.label = Some(String::new());
        let normalized = snap(vec![g]).normalize().expect("empty label is valid");
        assert_eq!(normalized.groups[0].label.as_deref(), Some(""));
    }

    #[test]
    fn only_host_actions_may_carry_args() {
        // Core/app commands are a fixed Rust-side allowlist: args on them would
        // be silently ignored, so the model rejects them instead.
        let mut item = action("core.item", 0);
        if let TrayItem::Action(value) = &mut item {
            value.action.target = TrayActionTarget::Core;
            value.action.args = vec![json!(1)];
        }
        assert!(snap(vec![group("g", 0, vec![item])]).normalize().is_err());

        // Host actions keep their args.
        let mut host_item = action("host.item", 0);
        if let TrayItem::Action(value) = &mut host_item {
            value.action.target = TrayActionTarget::Host;
            value.action.args = vec![json!(1), json!("two")];
        }
        let mut host_group = group("g", 0, vec![host_item]);
        host_group.source = TraySource::Host;
        let normalized = snap(vec![host_group]).normalize().unwrap();
        let TrayItem::Action(value) = &normalized.groups[0].items[0] else {
            panic!("expected action item");
        };
        assert_eq!(value.action.args, vec![json!(1), json!("two")]);
    }

    #[test]
    fn global_item_cap_is_enforced_across_groups() {
        // The schema caps each array at 512 items; the model additionally caps
        // the total at 512 so a host cannot push an unbounded native menu.
        let many = |prefix: &str| -> Vec<TrayItem> {
            (0..300)
                .map(|index| action(&format!("{prefix}.{index}"), index))
                .collect()
        };
        let mut first = group("g1", 0, many("a"));
        first.source = TraySource::Host;
        let mut second = group("g2", 1, many("b"));
        second.source = TraySource::Host;
        let err = snap(vec![first, second])
            .normalize()
            .expect_err("600 items exceed the global cap");
        assert!(err.contains("too many items"), "{err}");
    }
}
