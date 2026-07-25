#include <stdio.h>

volatile int rea_ghidra_inventory_global = 7;

__attribute__((noinline, used)) int rea_ghidra_inventory_leaf(int value) {
  puts("REA_GHIDRA_LEAF_VALUE");
  return value + rea_ghidra_inventory_global;
}

__attribute__((noinline, used)) int rea_ghidra_inventory_branch(int value) {
  if (value > 10) {
    return rea_ghidra_inventory_leaf(value);
  }
  return rea_ghidra_inventory_leaf(-value);
}

__attribute__((noinline, used)) int rea_ghidra_inventory_indirect(
    int (*callback)(int), int value) {
  return callback(value);
}

__attribute__((noinline, used)) int rea_ghidra_inventory_switch(
    unsigned int selector, int value) {
  switch (selector) {
    case 0:
      return rea_ghidra_inventory_leaf(value);
    case 1:
      return rea_ghidra_inventory_leaf(value + 3);
    case 2:
      return rea_ghidra_inventory_leaf(value - 5);
    case 3:
      return rea_ghidra_inventory_leaf(value * 2);
    case 4:
      return rea_ghidra_inventory_leaf(value ^ 0x55);
    case 5:
      return rea_ghidra_inventory_leaf(value | 0x20);
    case 6:
      return rea_ghidra_inventory_leaf(value & 0x3f);
    case 7:
      return rea_ghidra_inventory_leaf(value + rea_ghidra_inventory_global);
    default:
      return -1;
  }
}

__attribute__((noinline, used)) int rea_ghidra_inventory_entry(void) {
  puts("REA_GHIDRA_INVENTORY_ENTRY");
  return rea_ghidra_inventory_branch(35) +
         rea_ghidra_inventory_indirect(rea_ghidra_inventory_leaf, 0);
}

int main(void) { return rea_ghidra_inventory_entry() == 49 ? 0 : 1; }
