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
    #[serde(default)]
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
        for group in &mut self.groups {
            validate_id(&group.id)?;
            if !ids.insert(group.id.clone()) {
                return Err(format!("duplicate id: {}", group.id));
            }
            if group.source != TraySource::Core && group.id.starts_with("core.") {
                return Err("non-core group cannot use core.* id".into());
            }
            if let Some(label) = &group.label {
                validate_label(label)?;
            }
            total += validate_items(&mut group.items, 1, &mut ids)?;
        }
        if total > MAX_ITEMS {
            return Err("too many items".into());
        }
        self.groups
            .retain(|g| g.visible && g.items.iter().any(item_visible));
        for g in &mut self.groups {
            g.items = normalize_items(std::mem::take(&mut g.items));
        }
        self.groups
            .sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
        Ok(self)
    }
}

fn validate_items(
    items: &mut [TrayItem],
    depth: usize,
    ids: &mut HashSet<String>,
) -> Result<usize, String> {
    if depth > MAX_DEPTH {
        return Err("submenu nesting too deep".into());
    }
    let mut count = 0;
    let mut radios: HashMap<String, usize> = HashMap::new();
    for item in items {
        count += 1;
        let (id, _order, visible) = item_meta(item);
        let id = id.to_owned();
        let visible = *visible;
        validate_id(&id)?;
        if !ids.insert(id.clone()) {
            return Err(format!("duplicate id: {id}"));
        }
        if visible {
            match item {
                TrayItem::Action(v) => {
                    validate_label(&v.label)?;
                    validate_action(&v.action)?;
                }
                TrayItem::Check(v) => {
                    validate_label(&v.label)?;
                    validate_action(&v.action)?;
                    if v.radio_group.is_some() {
                        return Err("check item cannot have radio_group".into());
                    }
                }
                TrayItem::Radio(v) => {
                    validate_label(&v.label)?;
                    validate_action(&v.action)?;
                    let g = v
                        .radio_group
                        .as_ref()
                        .ok_or("radio item requires radio_group")?;
                    *radios.entry(g.clone()).or_default() += usize::from(v.checked);
                }
                TrayItem::Submenu(v) => {
                    validate_label(&v.label)?;
                    validate_items(&mut v.items, depth + 1, ids)?;
                }
                TrayItem::Separator(_) => {}
            }
        }
    }
    if radios.values().any(|checked| *checked > 1) {
        return Err("radio group has multiple checked items".into());
    }
    Ok(count)
}

fn validate_action(action: &TrayAction) -> Result<(), String> {
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
    items.retain(item_visible);
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
}
