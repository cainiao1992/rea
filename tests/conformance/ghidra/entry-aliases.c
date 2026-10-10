// Keep secondary imported entry labels and a non-entry control in one function.
#if defined(__APPLE__)
#define REA_SYMBOL(name) "_" name
#else
#define REA_SYMBOL(name) name
#endif

volatile int rea_xrefs_data = 17;
__attribute__((used)) volatile int rea_xrefs_unreferenced = 41;

__attribute__((noinline, used)) int rea_alias_target(void) {
  // ARM64 leaf functions may have no prologue; keep the control past entry.
  __asm__ volatile("nop\n.globl " REA_SYMBOL("rea_interior") "\n"
                   REA_SYMBOL("rea_interior") ":");
  return rea_xrefs_data;
}

__asm__(".globl " REA_SYMBOL("rea_entry_alias") "\n"
        ".set " REA_SYMBOL("rea_entry_alias") ", " REA_SYMBOL("rea_alias_target") "\n"
        // A bare hexadecimal identifier must still resolve as an entry label.
        ".globl dead\n.set dead, " REA_SYMBOL("rea_alias_target") "\n");

int main(void) { return rea_alias_target(); }
